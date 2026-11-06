'use strict';

// Tableau de bord et rapports. Lecture seule : aucune écriture ici.
// Règles : les transferts ne sont ni des revenus ni des dépenses ; une correction annule son opération d'origine ;
// les commissions calculées ne sont pas de l'argent encaissé (seules les encaissements comptent dans la caisse).

const F = require('./finance');
const M = require('./modules');

// Caisses visibles par l'acteur. Un non-administrateur ne voit jamais une caisse qui ne lui est pas attribuée.
function scopeIds(db, actor, registerId = null) {
  if (registerId != null) {
    F.requirePermission(actor, 'lire', registerId);
    return [registerId];
  }
  if (actor && actor.role === 'ADMINISTRATEUR') return db.all('SELECT id FROM cash_registers ORDER BY id').map((r) => r.id);
  return [...((actor && actor.registerIds) || [])];
}

const marks = (ids) => ids.map(() => '?').join(',');

// Vue normalisée : `cat` est la nature d'origine (une correction garde la nature de l'opération corrigée).
const BASE = `
  WITH base AS (
    SELECT t.id, t.register_id, t.sens, t.nature, t.categorie, t.montant, t.date, t.user_id,
           t.affecte_caisse, t.fournisseur_id, t.beneficiaire_id,
           COALESCE(o.nature, t.nature) AS cat
    FROM transactions t LEFT JOIN transactions o ON o.id = t.corrige_id
  )`;

const SIGNE = "CASE WHEN sens = 'entree' THEN montant ELSE -montant END";
const REVENU = `CASE WHEN cat IN ('revenu', 'commission') THEN ${SIGNE} END`;
const DEPENSE = `CASE WHEN cat = 'depense' THEN CASE WHEN sens = 'sortie' THEN montant ELSE -montant END END`;

// Totaux sur une période. Retourne aussi le mouvement net de caisse (opérations affectant la caisse, transferts inclus).
function summary(db, actor, { from, to, registerId = null }) {
  const ids = scopeIds(db, actor, registerId);
  if (!F.isValidDate(from) || !F.isValidDate(to)) throw new F.FinanceError('DATE_INVALIDE', 'Période invalide.');
  if (ids.length === 0) return { revenus: 0, depenses: 0, transfertsNets: 0, mouvementCaisse: 0, nbOperations: 0 };
  return db.get(
    `${BASE}
     SELECT COALESCE(SUM(${REVENU}), 0) AS revenus,
            COALESCE(SUM(${DEPENSE}), 0) AS depenses,
            COALESCE(SUM(CASE WHEN nature = 'transfert' THEN ${SIGNE} END), 0) AS transfertsNets,
            COALESCE(SUM(CASE WHEN affecte_caisse = 1 THEN ${SIGNE} END), 0) AS mouvementCaisse,
            COUNT(CASE WHEN nature IN ('revenu', 'depense', 'commission', 'correction') THEN 1 END) AS nbOperations
     FROM base WHERE register_id IN (${marks(ids)}) AND date BETWEEN ? AND ?`,
    [...ids, from, to],
  );
}

function byCategory(db, actor, { from, to, registerId = null }) {
  const ids = scopeIds(db, actor, registerId);
  if (ids.length === 0) return [];
  return db.all(
    `${BASE}
     SELECT categorie, COALESCE(SUM(${DEPENSE}), 0) AS total, COUNT(*) AS nb
     FROM base WHERE register_id IN (${marks(ids)}) AND date BETWEEN ? AND ? AND cat = 'depense'
     GROUP BY categorie ORDER BY total DESC`,
    [...ids, from, to],
  );
}

function byUser(db, actor, { from, to, registerId = null }) {
  const ids = scopeIds(db, actor, registerId);
  if (ids.length === 0) return [];
  return db.all(
    `${BASE}
     SELECT b.user_id, u.nom,
            COALESCE(SUM(${REVENU}), 0) AS revenus,
            COALESCE(SUM(${DEPENSE}), 0) AS depenses,
            COUNT(CASE WHEN nature IN ('revenu', 'depense', 'commission', 'correction') THEN 1 END) AS nbOperations
     FROM base b JOIN users u ON u.id = b.user_id
     WHERE b.register_id IN (${marks(ids)}) AND b.date BETWEEN ? AND ?
     GROUP BY b.user_id, u.nom ORDER BY u.nom`,
    [...ids, from, to],
  );
}

function bySupplier(db, actor, { from, to, registerId = null }) {
  const ids = scopeIds(db, actor, registerId);
  if (ids.length === 0) return [];
  return db.all(
    `${BASE}
     SELECT b.fournisseur_id, s.nom, COALESCE(SUM(${DEPENSE}), 0) AS total, COUNT(*) AS nb
     FROM base b JOIN suppliers s ON s.id = b.fournisseur_id
     WHERE b.register_id IN (${marks(ids)}) AND b.date BETWEEN ? AND ? AND b.cat = 'depense'
     GROUP BY b.fournisseur_id, s.nom ORDER BY total DESC`,
    [...ids, from, to],
  );
}

// Totaux par caisse : soldes actuels inclus.
function byRegister(db, actor, { from, to }) {
  const ids = scopeIds(db, actor, null);
  if (ids.length === 0) return [];
  return db.all(
    `${BASE}
     SELECT b.register_id, r.nom,
            COALESCE(SUM(${REVENU}), 0) AS revenus,
            COALESCE(SUM(${DEPENSE}), 0) AS depenses,
            COALESCE(SUM(CASE WHEN b.affecte_caisse = 1 THEN CASE WHEN b.sens = 'entree' THEN b.montant ELSE -b.montant END END), 0) AS mouvementCaisse
     FROM base b JOIN cash_registers r ON r.id = b.register_id
     WHERE b.register_id IN (${marks(ids)}) AND b.date BETWEEN ? AND ?
     GROUP BY b.register_id, r.nom ORDER BY r.nom`,
    [...ids, from, to],
  ).map((row) => ({ ...row, soldeActuel: F.getBalance(db, row.register_id) }));
}

// Série temporelle. Les totaux par jour sont regroupés en jour, semaine (lundi), mois ou année.
function series(db, actor, { from, to, granularite = 'mois', registerId = null }) {
  if (!['jour', 'semaine', 'mois', 'annee'].includes(granularite)) throw new F.FinanceError('GRANULARITE_INVALIDE', 'Granularité invalide.');
  const ids = scopeIds(db, actor, registerId);
  if (ids.length === 0) return [];
  const jours = db.all(
    `${BASE}
     SELECT date, COALESCE(SUM(${REVENU}), 0) AS revenus, COALESCE(SUM(${DEPENSE}), 0) AS depenses
     FROM base WHERE register_id IN (${marks(ids)}) AND date BETWEEN ? AND ? AND nature <> 'transfert'
     GROUP BY date ORDER BY date`,
    [...ids, from, to],
  );
  const groupes = new Map();
  for (const j of jours) {
    const cle = cleGroupe(j.date, granularite);
    const g = groupes.get(cle) || { periode: cle, revenus: 0, depenses: 0 };
    g.revenus += j.revenus;
    g.depenses += j.depenses;
    groupes.set(cle, g);
  }
  return [...groupes.values()].map((g) => ({ ...g, resultat: g.revenus - g.depenses }));
}

function cleGroupe(date, granularite) {
  if (granularite === 'jour') return date;
  if (granularite === 'mois') return date.slice(0, 7);
  if (granularite === 'annee') return date.slice(0, 4);
  const d = new Date(`${date}T00:00:00Z`);
  const lundi = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
  return lundi.toISOString().slice(0, 10);
}

function byCommission(db, actor, { from, to }) {
  F.requirePermission(actor, 'commission');
  return db.all(
    `SELECT c.id, c.reference, c.periode_debut, c.periode_fin, c.montant_calcule,
            COALESCE(SUM(cc.montant), 0) AS encaisse,
            c.montant_calcule - COALESCE(SUM(cc.montant), 0) AS reste
     FROM commissions c LEFT JOIN commission_collections cc ON cc.commission_id = c.id
     WHERE c.date_calcul BETWEEN ? AND ?
     GROUP BY c.id ORDER BY c.date_calcul DESC, c.id DESC`,
    [from, to],
  );
}

// Clôtures et écarts. Un écart non nul doit avoir une explication (contrôlé à la clôture).
function closingsReport(db, actor, { from, to, registerId = null }) {
  const ids = scopeIds(db, actor, registerId);
  if (ids.length === 0) return { lignes: [], parCaisse: [], totalEcart: 0, nbEcarts: 0 };
  const lignes = db.all(
    `SELECT c.*, r.nom AS caisse FROM daily_closings c JOIN cash_registers r ON r.id = c.register_id
     WHERE c.register_id IN (${marks(ids)}) AND c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.register_id`,
    [...ids, from, to],
  );
  const parCaisse = db.all(
    `SELECT c.register_id, r.nom AS caisse, COUNT(*) AS nbJours,
            COALESCE(SUM(c.ecart), 0) AS totalEcart,
            COALESCE(SUM(CASE WHEN c.ecart < 0 THEN -c.ecart ELSE c.ecart END), 0) AS ecartAbsolu
     FROM daily_closings c JOIN cash_registers r ON r.id = c.register_id
     WHERE c.register_id IN (${marks(ids)}) AND c.date BETWEEN ? AND ?
     GROUP BY c.register_id, r.nom`,
    [...ids, from, to],
  );
  const totalEcart = parCaisse.reduce((s, r) => s + r.totalEcart, 0);
  const nbEcarts = lignes.filter((l) => l.ecart !== 0).length;
  return { lignes, parCaisse, totalEcart, nbEcarts };
}

// Date décalée d'un nombre de jours (AAAA-MM-JJ).
function decaler(date, jours) {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + jours * 86400000).toISOString().slice(0, 10);
}

// Tableau de bord : données réelles uniquement, calculées à partir du journal financier.
function dashboard(db, actor, { date = F.todayAlgiers(), registerId = null } = {}) {
  if (!F.isValidDate(date)) throw new F.FinanceError('DATE_INVALIDE', 'Date invalide.');
  const ids = scopeIds(db, actor, registerId);
  const debutMois = `${date.slice(0, 7)}-01`;
  const hier = decaler(date, -1);

  const caisses = ids.map((id) => {
    const r = db.get('SELECT id, nom, seuil_alerte FROM cash_registers WHERE id = ?', [id]);
    const solde = F.getBalance(db, id);
    return { id, nom: r.nom, solde, seuilAlerte: r.seuil_alerte, soldeFaible: solde < r.seuil_alerte };
  });
  const soldeGlobal = caisses.reduce((s, c) => s + c.solde, 0);

  const jour = ids.length ? summary(db, actor, { from: date, to: date, registerId }) : null;
  const mois = ids.length ? summary(db, actor, { from: debutMois, to: date, registerId }) : null;

  const commissions = actor.role === 'ADMINISTRATEUR' || actor.role === 'RESPONSABLE'
    ? db.get(
      `SELECT COALESCE(SUM(c.montant_calcule), 0) AS calculees,
              COALESCE((SELECT SUM(montant) FROM commission_collections), 0) AS encaissees
       FROM commissions c`,
    )
    : null;
  if (commissions) commissions.restant = commissions.calculees - commissions.encaissees;

  // Alertes financières
  const alertes = [];
  for (const c of caisses) {
    if (c.soldeFaible) alertes.push({ type: 'solde_faible', niveau: 'alerte', message: `Solde faible : « ${c.nom} » (${c.solde} DA)`, lien: `/caisses/${c.id}` });
  }
  for (const id of ids) {
    const budgets = db.all('SELECT categorie FROM budgets WHERE register_id = ? AND mois = ?', [id, date.slice(0, 7)]);
    for (const b of budgets) {
      const s = M.budgetStatus(db, actor, id, b.categorie, date.slice(0, 7));
      if (s && s.niveau !== 'ok') {
        alertes.push({ type: 'budget', niveau: s.niveau, message: `Budget « ${b.categorie} » : ${s.pourcentage} % consommé`, lien: '/budgets' });
      }
    }
    const activite = db.get('SELECT COUNT(*) AS n FROM transactions WHERE register_id = ? AND date = ?', [id, hier]).n;
    const cloture = db.get("SELECT statut FROM daily_closings WHERE register_id = ? AND date = ? AND statut = 'cloturee'", [id, hier]);
    if (activite > 0 && !cloture) {
      const nom = db.get('SELECT nom FROM cash_registers WHERE id = ?', [id]).nom;
      alertes.push({ type: 'cloture_manquante', niveau: 'alerte', message: `Clôture manquante du ${hier.split('-').reverse().join('/')} : « ${nom} »`, lien: '/clotures' });
    }
  }
  const enAttente = ids.length
    ? db.get(
      `SELECT COUNT(*) AS n FROM recurring_expense_occurrences o JOIN recurring_expenses r ON r.id = o.recurring_id
       WHERE o.statut = 'proposee' AND r.register_id IN (${marks(ids)})`,
      ids,
    ).n
    : 0;
  if (enAttente > 0) alertes.push({ type: 'recurrente_a_confirmer', niveau: 'info', message: `${enAttente} dépense(s) récurrente(s) à confirmer`, lien: '/recurrentes' });

  return {
    date,
    caisses,
    soldeGlobal,
    entreesJour: jour ? jour.revenus : 0,
    depensesJour: jour ? jour.depenses : 0,
    entreesMois: mois ? mois.revenus : 0,
    depensesMois: mois ? mois.depenses : 0,
    nbOperationsJour: jour ? jour.nbOperations : 0,
    commissions,
    alertes,
  };
}

module.exports = {
  scopeIds,
  summary,
  byCategory,
  byUser,
  bySupplier,
  byRegister,
  series,
  byCommission,
  closingsReport,
  dashboard,
  decaler,
};
