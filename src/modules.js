'use strict';

// Modules : fournisseurs, bénéficiaires, budgets, dépenses récurrentes.
// S'appuie sur le noyau financier (src/finance.js) : aucune écriture de solde ne se fait ici en dehors du journal.

const F = require('./finance');

const fail = (code, message) => { throw new F.FinanceError(code, message); };

function texte(valeur, champ) {
  const v = typeof valeur === 'string' ? valeur.trim() : '';
  if (!v) fail('CHAMP_REQUIS', `${champ} est obligatoire.`);
  return v;
}

// ---------- Fournisseurs et bénéficiaires ----------

const TIERS = Object.freeze({
  fournisseurs: { table: 'suppliers', colonne: 'fournisseur_id' },
  beneficiaires: { table: 'beneficiaries', colonne: 'beneficiaire_id' },
});

function tiersConfig(kind) {
  const cfg = TIERS[kind];
  if (!cfg) throw new Error('Type de tiers inconnu');
  return cfg;
}

function createTiers(db, actor, kind, data) {
  const { table } = tiersConfig(kind);
  F.requirePermission(actor, 'tiers');
  const nom = texte(data.nom, 'Le nom');
  return db.transaction((tx) => {
    if (tx.get(`SELECT id FROM ${table} WHERE nom = ?`, [nom])) fail('DOUBLON', 'Ce nom existe déjà.');
    const id = tx.run(
      `INSERT INTO ${table} (nom, telephone, email, adresse, categorie, description) VALUES (?, ?, ?, ?, ?, ?)`,
      [nom, data.telephone || null, data.email || null, data.adresse || null, data.categorie || null, data.description || null],
    ).lastId;
    F.audit(tx, actor, 'creation_tiers', table, id, null, { nom });
    return { id, nom };
  });
}

function updateTiers(db, actor, kind, id, data) {
  const { table } = tiersConfig(kind);
  F.requirePermission(actor, 'tiers');
  const nom = texte(data.nom, 'Le nom');
  return db.transaction((tx) => {
    const avant = tx.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!avant) fail('TIERS_INTROUVABLE', 'Enregistrement introuvable.');
    if (tx.get(`SELECT id FROM ${table} WHERE nom = ? AND id <> ?`, [nom, id])) fail('DOUBLON', 'Ce nom existe déjà.');
    tx.run(
      `UPDATE ${table} SET nom = ?, telephone = ?, email = ?, adresse = ?, categorie = ?, description = ? WHERE id = ?`,
      [nom, data.telephone || null, data.email || null, data.adresse || null, data.categorie || null, data.description || null, id],
    );
    F.audit(tx, actor, 'modification_tiers', table, id, { nom: avant.nom }, { nom });
    return { id };
  });
}

function listTiers(db, actor, kind, { recherche = '' } = {}) {
  const { table } = tiersConfig(kind);
  F.requirePermission(actor, 'lire');
  const q = `%${recherche.trim()}%`;
  return db.all(`SELECT * FROM ${table} WHERE nom LIKE ? ORDER BY nom`, [q]);
}

// Historique, total payé, dernier paiement et factures associées.
function tiersStats(db, actor, kind, id) {
  const { table, colonne } = tiersConfig(kind);
  F.requirePermission(actor, 'lire');
  const fiche = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!fiche) fail('TIERS_INTROUVABLE', 'Enregistrement introuvable.');
  const total = db.get(
    `SELECT COALESCE(SUM(CASE WHEN sens = 'sortie' THEN montant ELSE -montant END), 0) AS total,
            COUNT(CASE WHEN nature = 'depense' THEN 1 END) AS nb
     FROM transactions WHERE ${colonne} = ? AND nature IN ('depense', 'correction') AND affecte_caisse IN (0, 1)`,
    [id],
  );
  const dernier = db.get(
    `SELECT MAX(date) AS dernier FROM transactions WHERE ${colonne} = ? AND nature = 'depense'`,
    [id],
  );
  const historique = db.all(
    `SELECT id, date, categorie, montant, sens, nature, numero_facture, description, register_id
     FROM transactions WHERE ${colonne} = ? AND nature IN ('depense', 'correction') ORDER BY date DESC, id DESC`,
    [id],
  );
  const factures = db.all(
    `SELECT DISTINCT numero_facture FROM transactions WHERE ${colonne} = ? AND numero_facture IS NOT NULL ORDER BY numero_facture`,
    [id],
  ).map((r) => r.numero_facture);
  return {
    fiche,
    totalPaye: total.total,
    nombreDepenses: total.nb,
    dernierPaiement: dernier.dernier,
    historique,
    factures,
  };
}

// ---------- Budgets ----------

// Dépenses réalisées = dépenses (y compris non payées en espèces) moins leurs corrections, sur le mois.
function budgetStatus(db, actor, registerId, categorie, mois) {
  F.requirePermission(actor, 'lire', registerId);
  const b = db.get(
    'SELECT * FROM budgets WHERE register_id = ? AND categorie = ? AND mois = ?',
    [registerId, categorie, mois],
  );
  if (!b) return null;
  const r = db.get(
    `SELECT COALESCE(SUM(CASE WHEN sens = 'sortie' THEN montant ELSE -montant END), 0) AS depense
     FROM transactions
     WHERE register_id = ? AND categorie = ? AND nature IN ('depense', 'correction') AND substr(date, 1, 7) = ?`,
    [registerId, categorie, mois],
  );
  const initial = b.montant_initial;
  const depense = r.depense;
  const restant = initial - depense;
  // Comparaisons en entiers pour éviter tout arrondi : pourcentage = depense * 100 / initial.
  let niveau = 'ok';
  if (depense * 100 > initial * 100) niveau = 'depassement';
  else if (depense * 100 === initial * 100) niveau = 'atteint';
  else if (depense * 100 >= initial * 80) niveau = 'avertissement';
  return {
    budgetId: b.id, registerId, categorie, mois, initial, depense, restant,
    pourcentage: Math.round((depense * 10000) / initial) / 100,
    niveau,
  };
}

function setBudget(db, actor, { registerId, categorie, mois, montant }) {
  F.requirePermission(actor, 'budget', registerId);
  if (!F.CATEGORIES_DEPENSE.includes(categorie)) fail('CATEGORIE_INVALIDE', 'Catégorie de dépense invalide.');
  if (!/^\d{4}-\d{2}$/.test(mois || '')) fail('MOIS_INVALIDE', 'Mois invalide (format AAAA-MM).');
  if (!Number.isInteger(montant) || montant <= 0) fail('MONTANT_INVALIDE', 'Le budget doit être un entier positif (DA).');
  return db.transaction((tx) => {
    const avant = tx.get('SELECT montant_initial FROM budgets WHERE register_id = ? AND categorie = ? AND mois = ?', [registerId, categorie, mois]);
    tx.run(
      `INSERT INTO budgets (register_id, categorie, mois, montant_initial, user_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (register_id, categorie, mois)
       DO UPDATE SET montant_initial = excluded.montant_initial, user_id = excluded.user_id, updated_at = datetime('now')`,
      [registerId, categorie, mois, montant, actor.userId],
    );
    F.audit(tx, actor, 'budget', 'budgets', registerId, avant ? { montant: avant.montant_initial } : null, { categorie, mois, montant });
    return budgetStatus(tx, actor, registerId, categorie, mois);
  });
}

// ---------- Dépenses récurrentes ----------

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Prochaine échéance selon la fréquence. Pour le mensuel et l'annuel, le jour est borné à la fin du mois.
function addPeriod(date, frequence) {
  const [y, m, d] = date.split('-').map(Number);
  let year = y;
  let monthIndex = m - 1;
  let day = d;
  if (frequence === 'quotidienne' || frequence === 'hebdomadaire') {
    const step = frequence === 'quotidienne' ? 1 : 7;
    const dt = new Date(Date.UTC(y, m - 1, d + step));
    return dt.toISOString().slice(0, 10);
  }
  if (frequence === 'mensuelle') {
    monthIndex += 1;
    if (monthIndex > 11) { monthIndex = 0; year += 1; }
  } else if (frequence === 'annuelle') {
    year += 1;
  } else {
    throw new Error('Fréquence inconnue');
  }
  day = Math.min(day, daysInMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

const FREQUENCES = Object.freeze(['quotidienne', 'hebdomadaire', 'mensuelle', 'annuelle']);

function createRecurring(db, actor, data) {
  const {
    libelle, categorie, montant, frequence, prochaineEcheance, registerId,
    fournisseurId = null, beneficiaireId = null, modePaiement = 'especes',
  } = data;
  F.requirePermission(actor, 'recurrente', registerId);
  texte(libelle, 'Le libellé');
  if (!F.CATEGORIES_DEPENSE.includes(categorie)) fail('CATEGORIE_INVALIDE', 'Catégorie de dépense invalide.');
  if (!Number.isInteger(montant) || montant <= 0) fail('MONTANT_INVALIDE', 'Le montant doit être un entier positif (DA).');
  if (!FREQUENCES.includes(frequence)) fail('FREQUENCE_INVALIDE', 'Fréquence invalide.');
  if (!F.isValidDate(prochaineEcheance)) fail('DATE_INVALIDE', 'Date invalide (format attendu : AAAA-MM-JJ).');
  if (!F.MODES_PAIEMENT.includes(modePaiement)) fail('MODE_PAIEMENT_INVALIDE', 'Mode de paiement invalide.');

  return db.transaction((tx) => {
    F.requirePermission(actor, 'recurrente', registerId);
    const reg = tx.get('SELECT id FROM cash_registers WHERE id = ?', [registerId]);
    if (!reg) fail('CAISSE_INTROUVABLE', 'Caisse introuvable.');
    if (fournisseurId != null && !tx.get('SELECT id FROM suppliers WHERE id = ?', [fournisseurId])) fail('TIERS_INTROUVABLE', 'Fournisseur introuvable.');
    if (beneficiaireId != null && !tx.get('SELECT id FROM beneficiaries WHERE id = ?', [beneficiaireId])) fail('TIERS_INTROUVABLE', 'Bénéficiaire introuvable.');
    const id = tx.run(
      `INSERT INTO recurring_expenses (libelle, categorie, montant, frequence, prochaine_echeance, register_id,
         fournisseur_id, beneficiaire_id, mode_paiement, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [libelle.trim(), categorie, montant, frequence, prochaineEcheance, registerId, fournisseurId, beneficiaireId, modePaiement, actor.userId],
    ).lastId;
    F.audit(tx, actor, 'creation_recurrente', 'recurring_expenses', id, null, { libelle, montant, frequence });
    return { id };
  });
}

// Crée les échéances « proposées » jusqu'à la date donnée. Ne débite jamais la caisse.
// Un doublon (même dépense, même échéance) est impossible grâce à la contrainte UNIQUE.
function generateDueOccurrences(db, actor, asOf) {
  F.requirePermission(actor, 'recurrente');
  if (!F.isValidDate(asOf)) fail('DATE_INVALIDE', 'Date invalide.');
  return db.transaction((tx) => {
    const rows = tx.all('SELECT * FROM recurring_expenses WHERE actif = 1 AND prochaine_echeance <= ?', [asOf]);
    let crees = 0;
    for (const r of rows) {
      let echeance = r.prochaine_echeance;
      while (echeance <= asOf) {
        const res = tx.run(
          'INSERT OR IGNORE INTO recurring_expense_occurrences (recurring_id, echeance) VALUES (?, ?)',
          [r.id, echeance],
        );
        crees += res.changes;
        echeance = addPeriod(echeance, r.frequence);
      }
      tx.run('UPDATE recurring_expenses SET prochaine_echeance = ? WHERE id = ?', [echeance, r.id]);
    }
    F.audit(tx, actor, 'generation_echeances', 'recurring_expenses', null, null, { asOf, crees });
    return { crees };
  });
}

// Confirmation explicite : seule action qui crée une sortie de caisse.
function confirmOccurrence(db, actor, { occurrenceId, date = null, ignorer = false }) {
  return db.transaction((tx) => {
    const occ = tx.get('SELECT * FROM recurring_expense_occurrences WHERE id = ?', [occurrenceId]);
    if (!occ) fail('ECHEANCE_INTROUVABLE', 'Échéance introuvable.');
    if (occ.statut !== 'proposee') fail('ECHEANCE_DEJA_TRAITEE', `Cette échéance est déjà ${occ.statut === 'confirmee' ? 'confirmée' : 'ignorée'}.`);
    const r = tx.get('SELECT * FROM recurring_expenses WHERE id = ?', [occ.recurring_id]);

    const now = new Date().toISOString();
    if (ignorer) {
      F.requirePermission(actor, 'operation', r.register_id);
      tx.run("UPDATE recurring_expense_occurrences SET statut = 'ignoree', decide_par = ?, decide_le = ? WHERE id = ?", [actor.userId, now, occ.id]);
      F.audit(tx, actor, 'echeance_ignoree', 'recurring_expense_occurrences', occ.id, null, { echeance: occ.echeance });
      return { statut: 'ignoree' };
    }

    F.requirePermission(actor, 'operation', r.register_id);
    const day = date || occ.echeance;
    if (!F.isValidDate(day)) fail('DATE_INVALIDE', 'Date invalide.');
    const res = F.recordOperationTx(tx, actor, {
      registerId: r.register_id, nature: 'depense', categorie: r.categorie, montant: r.montant, date: day,
      description: `${r.libelle} (échéance ${occ.echeance})`, reference: `REC-${r.id}-${occ.echeance}`,
      modePaiement: r.mode_paiement, fournisseurId: r.fournisseur_id, beneficiaireId: r.beneficiaire_id,
    });
    tx.run(
      "UPDATE recurring_expense_occurrences SET statut = 'confirmee', transaction_id = ?, decide_par = ?, decide_le = ? WHERE id = ?",
      [res.id, actor.userId, now, occ.id],
    );
    return { statut: 'confirmee', transactionId: res.id, soldeApres: res.soldeApres };
  });
}

function listOccurrences(db, actor, { statut = null } = {}) {
  F.requirePermission(actor, 'lire');
  const cond = statut ? 'AND o.statut = ?' : '';
  return db.all(
    `SELECT o.*, r.libelle, r.montant, r.categorie, r.register_id
     FROM recurring_expense_occurrences o JOIN recurring_expenses r ON r.id = o.recurring_id
     WHERE 1 = 1 ${cond} ORDER BY o.echeance`,
    statut ? [statut] : [],
  );
}

module.exports = {
  TIERS_KINDS: Object.keys(TIERS),
  createTiers,
  updateTiers,
  listTiers,
  tiersStats,
  budgetStatus,
  setBudget,
  addPeriod,
  createRecurring,
  generateDueOccurrences,
  confirmOccurrence,
  listOccurrences,
};
