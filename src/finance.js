'use strict';

// Noyau financier de MT Delivery — Gestion de caisse.
// Toutes les opérations passent ici. Le journal financier (table transactions) est la source de vérité des soldes.
// Les fonctions publiques ouvrent leur propre transaction ; les fonctions internes reçoivent `tx` et n'en ouvrent pas.

const ROLES = Object.freeze(['ADMINISTRATEUR', 'RESPONSABLE', 'CAISSIER', 'CONSULTATION']);

const ACTIONS_PAR_ROLE = Object.freeze({
  ADMINISTRATEUR: ['*'],
  RESPONSABLE: ['lire', 'operation', 'transfert', 'commission', 'cloturer', 'corriger', 'budget', 'recurrente', 'tiers'],
  CAISSIER: ['lire', 'operation', 'cloturer'],
  CONSULTATION: ['lire'],
});

const MODES_PAIEMENT = Object.freeze(['especes', 'cheque', 'virement', 'carte', 'autre']);
const CATEGORIES_REVENU = Object.freeze([
  'Commissions encaissées', 'Alimentation de caisse', 'Remboursements reçus', 'Apports financiers', 'Autres revenus',
]);
const CATEGORIES_DEPENSE = Object.freeze([
  'Papier', 'Fournitures de bureau', 'Consommables', 'Carburant', 'Transport', 'Maintenance', 'Informatique',
  'Internet', 'Téléphone', 'Loyer', 'Administration', 'Personnel', 'Emballage', 'Logistique', 'Divers',
]);

class FinanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinanceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FinanceError(code, message);
}

// ---------- Validation ----------

function assertAmount(montant) {
  if (!Number.isInteger(montant) || montant <= 0) {
    fail('MONTANT_INVALIDE', 'Le montant doit être un entier positif en dinars (DA).');
  }
}

function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

function assertDate(d) {
  if (!isValidDate(d)) fail('DATE_INVALIDE', 'Date invalide (format attendu : AAAA-MM-JJ).');
}

// Date du jour dans le fuseau de MT Delivery (Africa/Algiers), au format AAAA-MM-JJ.
function todayAlgiers(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Affichage DD/MM/YYYY pour les messages.
const fr = (d) => d.split('-').reverse().join('/');

// ---------- Permissions (contrôlées côté moteur, jamais seulement dans l'interface) ----------

// registerId === null/undefined => action globale (pas de caisse précise), seul le rôle compte.
function can(actor, action, registerId = null) {
  if (!actor || !ROLES.includes(actor.role)) return false;
  const actions = ACTIONS_PAR_ROLE[actor.role];
  if (!actions.includes('*') && !actions.includes(action)) return false;
  if (actor.role === 'ADMINISTRATEUR' || registerId == null) return true;
  return (actor.registerIds || []).includes(registerId);
}

function requirePermission(actor, action, registerId = null) {
  if (!can(actor, action, registerId)) fail('ACCES_REFUSE', 'Accès refusé pour cette action.');
}

// ---------- Lecture de base ----------

function getRegister(db, registerId) {
  const reg = db.get('SELECT * FROM cash_registers WHERE id = ?', [registerId]);
  if (!reg) fail('CAISSE_INTROUVABLE', 'Caisse introuvable.');
  return reg;
}

function getActiveRegister(db, registerId) {
  const reg = getRegister(db, registerId);
  if (reg.statut !== 'active') fail('CAISSE_INACTIVE', `La caisse « ${reg.nom} » est inactive.`);
  return reg;
}

// op : '<' ou '<=' uniquement (valeurs contrôlées par le code, jamais saisies par l'utilisateur).
function movementSum(db, registerId, op = null, date = null) {
  if (op !== null && op !== '<' && op !== '<=') throw new Error('Opérateur interdit');
  const cond = op ? `AND date ${op} ?` : '';
  const params = op ? [registerId, date] : [registerId];
  const row = db.get(
    `SELECT COALESCE(SUM(CASE WHEN sens = 'entree' THEN montant ELSE -montant END), 0) AS mv
     FROM transactions WHERE register_id = ? AND affecte_caisse = 1 ${cond}`,
    params,
  );
  return row.mv;
}

// Solde actuel d'une caisse = solde initial + mouvements de caisse (journal financier).
function getBalance(db, registerId) {
  return getRegister(db, registerId).solde_initial + movementSum(db, registerId);
}

function balanceAt(db, registerId, op, date) {
  return getRegister(db, registerId).solde_initial + movementSum(db, registerId, op, date);
}

// Somme des soldes de toutes les caisses. Un transfert ne doit jamais la modifier.
function getGlobalBalance(db) {
  return db.all('SELECT id FROM cash_registers').reduce((s, r) => s + getBalance(db, r.id), 0);
}

// ---------- Contrôles internes ----------

function assertFonds(db, registerId, date, montant) {
  const solde = balanceAt(db, registerId, '<=', date);
  if (solde < montant) {
    fail('SOLDE_INSUFFISANT', `Solde insuffisant : ${solde} DA disponibles, ${montant} DA demandés.`);
  }
}

function assertNotClosed(db, registerId, date) {
  const row = db.get('SELECT statut FROM daily_closings WHERE register_id = ? AND date = ?', [registerId, date]);
  if (row && row.statut === 'cloturee') {
    fail('PERIODE_CLOTUREE', `La journée du ${fr(date)} est clôturée : modification non autorisée.`);
  }
}

function assertReferenceLibre(db, registerId, reference) {
  const row = db.get('SELECT id FROM transactions WHERE register_id = ? AND reference = ?', [registerId, reference]);
  if (row) fail('DOUBLON', 'Une opération avec cette référence existe déjà sur cette caisse.');
}

function audit(db, actor, action, entite, entiteId, avant, apres) {
  db.run(
    `INSERT INTO audit_logs (user_id, action, entite, entite_id, donnees_avant, donnees_apres)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      actor && actor.userId != null ? actor.userId : null,
      action,
      entite,
      entiteId ?? null,
      avant == null ? null : JSON.stringify(avant),
      apres == null ? null : JSON.stringify(apres),
    ],
  );
}

function insertTransaction(db, t) {
  const r = db.run(
    `INSERT INTO transactions
       (register_id, sens, nature, categorie, montant, date, description, reference, user_id,
        affecte_caisse, mode_paiement, fournisseur_id, beneficiaire_id, transfert_id, corrige_id, numero_facture)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.registerId, t.sens, t.nature, t.categorie ?? null, t.montant, t.date, t.description ?? null,
      t.reference ?? null, t.userId, t.affecte ?? 1, t.modePaiement ?? null, t.fournisseurId ?? null,
      t.beneficiaireId ?? null, t.transfertId ?? null, t.corrigeId ?? null, t.numeroFacture ?? null,
    ],
  );
  return r.lastId;
}

// ---------- Opérations (entrées et dépenses) ----------

function recordOperation(db, actor, op) {
  const {
    registerId, nature, categorie = null, montant, date, description = null, reference = null,
    modePaiement = 'especes', fournisseurId = null, beneficiaireId = null, numeroFacture = null,
  } = op;

  if (nature !== 'revenu' && nature !== 'depense') fail('NATURE_INVALIDE', "Nature d'opération invalide.");
  requirePermission(actor, 'operation', registerId);
  assertAmount(montant);
  assertDate(date);

  if (nature === 'revenu' && !CATEGORIES_REVENU.includes(categorie)) {
    fail('CATEGORIE_INVALIDE', 'Catégorie de revenu invalide.');
  }
  if (nature === 'depense') {
    if (!CATEGORIES_DEPENSE.includes(categorie)) fail('CATEGORIE_INVALIDE', 'Catégorie de dépense invalide.');
    if (!MODES_PAIEMENT.includes(modePaiement)) fail('MODE_PAIEMENT_INVALIDE', 'Mode de paiement invalide.');
  }

  return db.transaction((tx) => recordOperationTx(tx, actor, {
    registerId, nature, categorie, montant, date, description, reference,
    modePaiement, fournisseurId, beneficiaireId, numeroFacture,
  }));
}

// Écriture d'une opération dans une transaction déjà ouverte (utilisée aussi par les dépenses récurrentes).
// Les droits et les montants doivent avoir été vérifiés par l'appelant (voir recordOperation).
function recordOperationTx(tx, actor, op) {
  const {
    registerId, nature, categorie, montant, date, description, reference, modePaiement,
    fournisseurId, beneficiaireId, numeroFacture,
  } = op;
  const sens = nature === 'revenu' ? 'entree' : 'sortie';
  // Une dépense non payée en espèces ne réduit pas la caisse physique.
  const affecte = nature === 'depense' && modePaiement !== 'especes' ? 0 : 1;

  getActiveRegister(tx, registerId);
  assertNotClosed(tx, registerId, date);
  if (reference) assertReferenceLibre(tx, registerId, reference);
  if (fournisseurId != null) assertExists(tx, 'suppliers', fournisseurId, 'Fournisseur');
  if (beneficiaireId != null) assertExists(tx, 'beneficiaries', beneficiaireId, 'Bénéficiaire');
  if (sens === 'sortie' && affecte === 1) assertFonds(tx, registerId, date, montant);

  const id = insertTransaction(tx, {
    registerId, sens, nature, categorie, montant, date, description, reference,
    userId: actor.userId, affecte, modePaiement: nature === 'depense' ? modePaiement : null,
    fournisseurId, beneficiaireId, numeroFacture,
  });
  audit(tx, actor, 'creation_operation', 'transactions', id, null, { registerId, nature, categorie, montant, date, reference, affecte });
  return { id, soldeApres: getBalance(tx, registerId) };
}

const TABLES_TIERS = Object.freeze(['suppliers', 'beneficiaries']);
function assertExists(db, table, id, libelle) {
  if (!TABLES_TIERS.includes(table)) throw new Error('Table interdite');
  if (!db.get(`SELECT id FROM ${table} WHERE id = ?`, [id])) fail('TIERS_INTROUVABLE', `${libelle} introuvable.`);
}

// ---------- Transferts entre caisses ----------

function transfer(db, actor, { sourceId, destinationId, montant, date, description = null, reference = null }) {
  if (sourceId === destinationId) {
    fail('TRANSFERT_MEME_CAISSE', 'La caisse source et la caisse destinataire doivent être différentes.');
  }
  requirePermission(actor, 'transfert', sourceId);
  requirePermission(actor, 'transfert', destinationId);
  assertAmount(montant);
  assertDate(date);

  const ref = reference && reference.trim() ? reference.trim() : `TRF-${date.replace(/-/g, '')}-${Date.now()}`;

  return db.transaction((tx) => {
    const source = getActiveRegister(tx, sourceId);
    const dest = getActiveRegister(tx, destinationId);
    assertNotClosed(tx, sourceId, date);
    assertNotClosed(tx, destinationId, date);
    if (tx.get('SELECT id FROM cash_transfers WHERE reference = ?', [ref])) {
      fail('DOUBLON', 'Un transfert avec cette référence existe déjà.');
    }
    assertFonds(tx, sourceId, date, montant);

    const tId = tx.run(
      `INSERT INTO cash_transfers (source_id, destination_id, montant, date, description, reference, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sourceId, destinationId, montant, date, description, ref, actor.userId],
    ).lastId;

    const sortieId = insertTransaction(tx, {
      registerId: sourceId, sens: 'sortie', nature: 'transfert', montant, date,
      description: description || `Transfert vers ${dest.nom}`, userId: actor.userId, transfertId: tId,
    });
    const entreeId = insertTransaction(tx, {
      registerId: destinationId, sens: 'entree', nature: 'transfert', montant, date,
      description: description || `Transfert depuis ${source.nom}`, userId: actor.userId, transfertId: tId,
    });
    tx.run('UPDATE cash_transfers SET transaction_sortie_id = ?, transaction_entree_id = ? WHERE id = ?', [sortieId, entreeId, tId]);

    audit(tx, actor, 'transfert', 'cash_transfers', tId, null, { sourceId, destinationId, montant, date, reference: ref });
    return {
      id: tId,
      reference: ref,
      soldeSource: getBalance(tx, sourceId),
      soldeDestination: getBalance(tx, destinationId),
    };
  });
}

// ---------- Commissions de livraison ----------

function resteACollecter(db, commissionId) {
  const row = db.get(
    `SELECT c.montant_calcule - COALESCE(SUM(cc.montant), 0) AS reste
     FROM commissions c LEFT JOIN commission_collections cc ON cc.commission_id = c.id
     WHERE c.id = ? GROUP BY c.id`,
    [commissionId],
  );
  if (!row) fail('COMMISSION_INTROUVABLE', 'Commission introuvable.');
  return row.reste;
}

function createCommission(db, actor, { reference, periodeDebut, periodeFin, dateCalcul, montant, description = null }) {
  requirePermission(actor, 'commission'); // action globale
  if (!reference || !reference.trim()) fail('REFERENCE_REQUISE', 'La référence de commission est obligatoire.');
  assertAmount(montant);
  assertDate(periodeDebut);
  assertDate(periodeFin);
  assertDate(dateCalcul);
  if (periodeDebut > periodeFin) fail('PERIODE_INVALIDE', 'La période est invalide (début après fin).');

  return db.transaction((tx) => {
    const ref = reference.trim();
    if (tx.get('SELECT id FROM commissions WHERE reference = ?', [ref])) {
      fail('DOUBLON', 'Une commission avec cette référence existe déjà.');
    }
    const id = tx.run(
      `INSERT INTO commissions (reference, periode_debut, periode_fin, date_calcul, montant_calcule, description, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ref, periodeDebut, periodeFin, dateCalcul, montant, description, actor.userId],
    ).lastId;
    audit(tx, actor, 'creation_commission', 'commissions', id, null, { reference: ref, montant });
    return { id, reste: montant };
  });
}

// Seules les sommes réellement encaissées créent une entrée dans la caisse.
function collectCommission(db, actor, { commissionId, registerId, montant, date, reference = null, description = null }) {
  requirePermission(actor, 'commission', registerId);
  assertAmount(montant);
  assertDate(date);

  return db.transaction((tx) => {
    const c = tx.get('SELECT * FROM commissions WHERE id = ?', [commissionId]);
    if (!c) fail('COMMISSION_INTROUVABLE', 'Commission introuvable.');
    getActiveRegister(tx, registerId);
    assertNotClosed(tx, registerId, date);

    const reste = resteACollecter(tx, commissionId);
    if (montant > reste) {
      fail('DEPASSEMENT_COMMISSION', `Le montant dépasse le reste à encaisser (${reste} DA).`);
    }
    if (reference) assertReferenceLibre(tx, registerId, reference);

    const txId = insertTransaction(tx, {
      registerId, sens: 'entree', nature: 'commission', categorie: 'Commissions encaissées', montant, date,
      description: description || `Encaissement commission ${c.reference}`, reference, userId: actor.userId,
    });
    const collId = tx.run(
      `INSERT INTO commission_collections (commission_id, register_id, transaction_id, montant, date, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [commissionId, registerId, txId, montant, date, actor.userId],
    ).lastId;

    audit(tx, actor, 'encaissement_commission', 'commission_collections', collId, null, { commissionId, montant, date, registerId });
    return { collectionId: collId, transactionId: txId, resteApres: reste - montant };
  });
}

// ---------- Clôtures quotidiennes ----------

// Flux d'une journée. Les transferts sont séparés des revenus et dépenses.
function flowsForDay(db, registerId, date) {
  const r = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN nature <> 'transfert' AND sens = 'entree' THEN montant END), 0) AS entrees,
       COALESCE(SUM(CASE WHEN nature <> 'transfert' AND sens = 'sortie' THEN montant END), 0) AS sorties,
       COALESCE(SUM(CASE WHEN nature = 'transfert' AND sens = 'entree' THEN montant END), 0) AS recus,
       COALESCE(SUM(CASE WHEN nature = 'transfert' AND sens = 'sortie' THEN montant END), 0) AS envoyes
     FROM transactions WHERE register_id = ? AND affecte_caisse = 1 AND date = ?`,
    [registerId, date],
  );
  const opening = balanceAt(db, registerId, '<', date);
  const theorique = opening + r.entrees - r.sorties + r.recus - r.envoyes;
  return {
    opening, entrees: r.entrees, sorties: r.sorties, recus: r.recus, envoyes: r.envoyes, theorique,
  };
}

function closeDay(db, actor, { registerId, date, actual, explication = null }) {
  requirePermission(actor, 'cloturer', registerId);
  assertDate(date);
  if (!Number.isInteger(actual) || actual < 0) fail('MONTANT_INVALIDE', 'Le solde réel compté doit être un entier positif ou nul (DA).');

  return db.transaction((tx) => {
    getRegister(tx, registerId);
    const existing = tx.get('SELECT id, statut FROM daily_closings WHERE register_id = ? AND date = ?', [registerId, date]);
    if (existing && existing.statut === 'cloturee') fail('PERIODE_CLOTUREE', `La journée du ${fr(date)} est déjà clôturée.`);

    const f = flowsForDay(tx, registerId, date);
    const ecart = actual - f.theorique;
    const expl = (explication || '').trim();
    if (ecart !== 0 && !expl) fail('EXPLICATION_REQUISE', "Une explication est obligatoire en cas d'écart.");

    const now = new Date().toISOString();
    if (existing) {
      tx.run(
        `UPDATE daily_closings SET solde_ouverture = ?, entrees = ?, sorties = ?, transferts_recus = ?, transferts_envoyes = ?,
           solde_theorique = ?, solde_reel = ?, ecart = ?, explication = ?, statut = 'cloturee',
           cloture_par = ?, cloture_le = ? WHERE id = ?`,
        [f.opening, f.entrees, f.sorties, f.recus, f.envoyes, f.theorique, actual, ecart, expl || null, actor.userId, now, existing.id],
      );
    } else {
      tx.run(
        `INSERT INTO daily_closings (register_id, date, solde_ouverture, entrees, sorties, transferts_recus, transferts_envoyes,
           solde_theorique, solde_reel, ecart, explication, statut, cloture_par, cloture_le)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloturee', ?, ?)`,
        [registerId, date, f.opening, f.entrees, f.sorties, f.recus, f.envoyes, f.theorique, actual, ecart, expl || null, actor.userId, now],
      );
    }
    audit(tx, actor, 'cloture', 'daily_closings', registerId, null, { date, theorique: f.theorique, reel: actual, ecart });
    return { date, ...f, reel: actual, ecart, explication: expl || null };
  });
}

// Réouverture : administrateur uniquement, motif obligatoire, traçabilité complète.
function reopenDay(db, actor, { registerId, date, motif }) {
  requirePermission(actor, 'reouvrir', registerId);
  assertDate(date);
  if (!(motif || '').trim()) fail('MOTIF_REQUIS', 'Un motif est obligatoire pour rouvrir une journée.');

  return db.transaction((tx) => {
    const c = tx.get('SELECT id, statut FROM daily_closings WHERE register_id = ? AND date = ?', [registerId, date]);
    if (!c || c.statut !== 'cloturee') fail('NON_CLOTUREE', "Cette journée n'est pas clôturée.");
    const now = new Date().toISOString();
    tx.run(
      `UPDATE daily_closings SET statut = 'reouverte', reouverte_par = ?, reouverte_le = ?, motif_reouverture = ? WHERE id = ?`,
      [actor.userId, now, motif.trim(), c.id],
    );
    audit(tx, actor, 'reouverture', 'daily_closings', c.id, { statut: 'cloturee' }, { statut: 'reouverte', motif: motif.trim(), date });
    return { date, statut: 'reouverte' };
  });
}

// ---------- Corrections par contre-écriture ----------

function correctTransaction(db, actor, { transactionId, motif, date = null }) {
  const orig = db.get('SELECT * FROM transactions WHERE id = ?', [transactionId]);
  if (!orig) fail('OPERATION_INTROUVABLE', 'Opération introuvable.');
  requirePermission(actor, 'corriger', orig.register_id);
  if (!(motif || '').trim()) fail('MOTIF_REQUIS', 'Un motif est obligatoire pour corriger une opération.');
  if (orig.nature === 'transfert') fail('CORRECTION_TRANSFERT', 'Un transfert ne se corrige pas ainsi.');
  if (orig.nature === 'commission') fail('CORRECTION_COMMISSION', 'Un encaissement de commission ne se corrige pas ainsi.');
  if (orig.nature === 'correction') fail('CORRECTION_NON_CORRIGEABLE', 'Une contre-écriture ne peut pas être corrigée.');

  const day = date || todayAlgiers();
  assertDate(day);

  return db.transaction((tx) => {
    if (tx.get('SELECT id FROM transactions WHERE corrige_id = ?', [orig.id])) {
      fail('DEJA_CORRIGE', 'Cette opération a déjà été corrigée.');
    }
    assertNotClosed(tx, orig.register_id, day);

    const sens = orig.sens === 'entree' ? 'sortie' : 'entree';
    if (sens === 'sortie' && orig.affecte_caisse === 1) assertFonds(tx, orig.register_id, day, orig.montant);

    const id = insertTransaction(tx, {
      registerId: orig.register_id, sens, nature: 'correction', categorie: orig.categorie, montant: orig.montant,
      date: day, description: `Correction de l'opération #${orig.id} : ${motif.trim()}`, userId: actor.userId,
      affecte: orig.affecte_caisse, modePaiement: orig.mode_paiement, fournisseurId: orig.fournisseur_id,
      beneficiaireId: orig.beneficiaire_id, corrigeId: orig.id,
    });
    audit(tx, actor, 'correction', 'transactions', id, { originale: orig.id, montant: orig.montant }, { motif: motif.trim(), date: day });
    return { id, soldeApres: getBalance(tx, orig.register_id) };
  });
}

module.exports = {
  ROLES,
  ACTIONS_PAR_ROLE,
  MODES_PAIEMENT,
  CATEGORIES_REVENU,
  CATEGORIES_DEPENSE,
  FinanceError,
  can,
  requirePermission,
  todayAlgiers,
  isValidDate,
  getBalance,
  getGlobalBalance,
  flowsForDay,
  recordOperation,
  recordOperationTx,
  audit,
  assertFonds,
  assertNotClosed,
  balanceAt,
  transfer,
  createCommission,
  collectCommission,
  resteACollecter,
  closeDay,
  reopenDay,
  correctTransaction,
};
