'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDatabase } = require('../src/db-node');
const F = require('../src/finance');
const M = require('../src/modules');

const MIG = path.join(__dirname, '..', 'migrations');

function setup() {
  const db = openDatabase(':memory:');
  db.migrate(path.join(MIG, '0001_noyau_financier.sql'));
  db.migrate(path.join(MIG, '0002_budgets_tiers_recurrentes.sql'));
  db.run(`INSERT INTO users (id, nom, role) VALUES
    (1, 'Admin', 'ADMINISTRATEUR'), (2, 'Caissier', 'CAISSIER'),
    (3, 'Responsable', 'RESPONSABLE'), (4, 'Consultation', 'CONSULTATION')`);
  db.run(`INSERT INTO cash_registers (id, code, nom, solde_initial, date_ouverture) VALUES
    (1, 'PRINC', 'Caisse principale', 100000, '2026-01-01'),
    (2, 'ADMIN', 'Caisse administration', 0, '2026-01-01')`);
  const admin = { userId: 1, role: 'ADMINISTRATEUR', registerIds: [] };
  const caissier = { userId: 2, role: 'CAISSIER', registerIds: [1] };
  const responsable = { userId: 3, role: 'RESPONSABLE', registerIds: [1, 2] };
  const consultation = { userId: 4, role: 'CONSULTATION', registerIds: [1] };
  return { db, admin, caissier, responsable, consultation };
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof F.FinanceError && err.code === code);
}

const depense = (db, actor, montant, date, extra = {}) => F.recordOperation(db, actor, {
  registerId: 1, nature: 'depense', categorie: 'Papier', montant, date, ...extra,
});

// 5. Budget de 50 000, dépenses de 40 000 : alerte à 80 %
test('5. budget : alerte à 80 %, puis atteint à 100 % et dépassement', () => {
  const { db, responsable, caissier } = setup();
  M.setBudget(db, responsable, { registerId: 1, categorie: 'Papier', mois: '2026-02', montant: 50000 });
  depense(db, caissier, 40000, '2026-02-05');
  let s = M.budgetStatus(db, caissier, 1, 'Papier', '2026-02');
  assert.equal(s.depense, 40000);
  assert.equal(s.restant, 10000);
  assert.equal(s.pourcentage, 80);
  assert.equal(s.niveau, 'avertissement');

  depense(db, caissier, 10000, '2026-02-06');
  assert.equal(M.budgetStatus(db, caissier, 1, 'Papier', '2026-02').niveau, 'atteint');

  depense(db, caissier, 5000, '2026-02-07', { modePaiement: 'virement' });
  s = M.budgetStatus(db, caissier, 1, 'Papier', '2026-02');
  assert.equal(s.niveau, 'depassement');
  assert.equal(s.depense, 55000, 'les dépenses non payées en espèces comptent dans le budget');
});

test('5b. une correction de dépense réduit le budget réalisé, les autres mois ne comptent pas', () => {
  const { db, responsable, caissier } = setup();
  M.setBudget(db, responsable, { registerId: 1, categorie: 'Papier', mois: '2026-02', montant: 50000 });
  const { id } = depense(db, caissier, 20000, '2026-02-05');
  depense(db, caissier, 9000, '2026-03-05');
  F.correctTransaction(db, responsable, { transactionId: id, motif: 'erreur', date: '2026-02-05' });
  assert.equal(M.budgetStatus(db, caissier, 1, 'Papier', '2026-02').depense, 0);
});

test('5c. budget : catégorie ou mois invalides refusés, caissier sans droit', () => {
  const { db, responsable, caissier } = setup();
  expectCode(() => M.setBudget(db, responsable, { registerId: 1, categorie: 'Inconnue', mois: '2026-02', montant: 100 }), 'CATEGORIE_INVALIDE');
  expectCode(() => M.setBudget(db, responsable, { registerId: 1, categorie: 'Papier', mois: '2026-2', montant: 100 }), 'MOIS_INVALIDE');
  expectCode(() => M.setBudget(db, caissier, { registerId: 1, categorie: 'Papier', mois: '2026-02', montant: 100 }), 'ACCES_REFUSE');
});

// 6. Dépense récurrente : aucune sortie sans confirmation
test('6. dépense récurrente : rien ne sort sans confirmation, pas de doublon par échéance', () => {
  const { db, admin, responsable, caissier } = setup();
  const { id } = M.createRecurring(db, responsable, {
    libelle: 'Loyer', categorie: 'Loyer', montant: 30000, frequence: 'mensuelle',
    prochaineEcheance: '2026-02-01', registerId: 1,
  });
  const res = M.generateDueOccurrences(db, admin, '2026-03-10');
  assert.equal(res.crees, 2, 'deux échéances : 01/02 et 01/03');
  assert.equal(F.getBalance(db, 1), 100000, 'aucune débit automatique');

  const again = M.generateDueOccurrences(db, admin, '2026-03-10');
  assert.equal(again.crees, 0, 'pas de doublon pour une même période');
  assert.equal(db.get('SELECT prochaine_echeance FROM recurring_expenses WHERE id = ?', [id]).prochaine_echeance, '2026-04-01');

  const occ = M.listOccurrences(db, caissier, { statut: 'proposee' })[0];
  const conf = M.confirmOccurrence(db, caissier, { occurrenceId: occ.id });
  assert.equal(conf.statut, 'confirmee');
  assert.equal(F.getBalance(db, 1), 70000);
  expectCode(() => M.confirmOccurrence(db, caissier, { occurrenceId: occ.id }), 'ECHEANCE_DEJA_TRAITEE');
});

test('6b. échéance ignorée : aucune sortie', () => {
  const { db, admin, responsable, caissier } = setup();
  M.createRecurring(db, responsable, {
    libelle: 'Internet', categorie: 'Internet', montant: 4000, frequence: 'mensuelle', prochaineEcheance: '2026-02-15', registerId: 1,
  });
  M.generateDueOccurrences(db, admin, '2026-02-20');
  const occ = M.listOccurrences(db, caissier, { statut: 'proposee' })[0];
  M.confirmOccurrence(db, caissier, { occurrenceId: occ.id, ignorer: true });
  assert.equal(F.getBalance(db, 1), 100000);
  expectCode(() => M.confirmOccurrence(db, caissier, { occurrenceId: occ.id }), 'ECHEANCE_DEJA_TRAITEE');
});

test('6c. calcul des échéances (fin de mois, année bissextile, fréquences)', () => {
  assert.equal(M.addPeriod('2026-01-31', 'mensuelle'), '2026-02-28');
  assert.equal(M.addPeriod('2028-01-31', 'mensuelle'), '2028-02-29');
  assert.equal(M.addPeriod('2026-12-15', 'mensuelle'), '2027-01-15');
  assert.equal(M.addPeriod('2028-02-29', 'annuelle'), '2029-02-28');
  assert.equal(M.addPeriod('2026-02-27', 'hebdomadaire'), '2026-03-06');
  assert.equal(M.addPeriod('2026-02-28', 'quotidienne'), '2026-03-01');
});

test('6d. récurrente : caissier ne peut pas la créer ni la confirmer hors de sa caisse', () => {
  const { db, responsable, caissier, admin } = setup();
  expectCode(() => M.createRecurring(db, caissier, {
    libelle: 'X', categorie: 'Divers', montant: 100, frequence: 'mensuelle', prochaineEcheance: '2026-02-01', registerId: 1,
  }), 'ACCES_REFUSE');
  M.createRecurring(db, responsable, {
    libelle: 'Autre', categorie: 'Divers', montant: 100, frequence: 'mensuelle', prochaineEcheance: '2026-02-01', registerId: 2,
  });
  M.generateDueOccurrences(db, admin, '2026-02-01');
  const occ = M.listOccurrences(db, admin, { statut: 'proposee' })[0];
  expectCode(() => M.confirmOccurrence(db, caissier, { occurrenceId: occ.id }), 'ACCES_REFUSE');
});

// Fournisseurs et bénéficiaires
test('fournisseurs : création, doublon, statistiques de paiement et factures', () => {
  const { db, responsable, caissier } = setup();
  const { id } = M.createTiers(db, responsable, 'fournisseurs', { nom: 'Papeterie Centrale', telephone: '0555000000' });
  expectCode(() => M.createTiers(db, responsable, 'fournisseurs', { nom: 'Papeterie Centrale' }), 'DOUBLON');
  expectCode(() => M.createTiers(db, responsable, 'fournisseurs', { nom: '  ' }), 'CHAMP_REQUIS');

  depense(db, caissier, 12000, '2026-02-03', { fournisseurId: id, numeroFacture: 'FA-001' });
  depense(db, caissier, 3000, '2026-02-10', { fournisseurId: id, numeroFacture: 'FA-002', modePaiement: 'virement' });
  const stats = M.tiersStats(db, responsable, 'fournisseurs', id);
  assert.equal(stats.totalPaye, 15000);
  assert.equal(stats.nombreDepenses, 2);
  assert.equal(stats.dernierPaiement, '2026-02-10');
  assert.deepEqual(stats.factures, ['FA-001', 'FA-002']);
  assert.equal(stats.historique.length, 2);
  assert.equal(F.getBalance(db, 1), 88000, 'le virement ne sort pas de la caisse');
});

test('dépense liée à un fournisseur inexistant refusée ; bénéficiaires gérés séparément', () => {
  const { db, responsable, caissier } = setup();
  expectCode(() => depense(db, caissier, 100, '2026-02-03', { fournisseurId: 999 }), 'TIERS_INTROUVABLE');
  const b = M.createTiers(db, responsable, 'beneficiaires', { nom: 'Ahmed Livreur' });
  depense(db, caissier, 500, '2026-02-03', { beneficiaireId: b.id });
  assert.equal(M.tiersStats(db, responsable, 'beneficiaires', b.id).totalPaye, 500);
  assert.equal(M.listTiers(db, responsable, 'fournisseurs').length, 0);
});

test('tiers : modification avec contrôle de doublon', () => {
  const { db, responsable } = setup();
  const a = M.createTiers(db, responsable, 'fournisseurs', { nom: 'A' });
  M.createTiers(db, responsable, 'fournisseurs', { nom: 'B' });
  expectCode(() => M.updateTiers(db, responsable, 'fournisseurs', a.id, { nom: 'B' }), 'DOUBLON');
  M.updateTiers(db, responsable, 'fournisseurs', a.id, { nom: 'A2', telephone: '0660000000' });
  assert.equal(M.listTiers(db, responsable, 'fournisseurs', { recherche: 'A2' })[0].telephone, '0660000000');
});
