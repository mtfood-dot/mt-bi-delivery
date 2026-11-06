'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDatabase } = require('../src/db-node');
const F = require('../src/finance');
const M = require('../src/modules');
const R = require('../src/reports');

const MIG = path.join(__dirname, '..', 'migrations');

function setup() {
  const db = openDatabase(':memory:');
  db.migrate(path.join(MIG, '0001_noyau_financier.sql'));
  db.migrate(path.join(MIG, '0002_budgets_tiers_recurrentes.sql'));
  db.run(`INSERT INTO users (id, nom, role) VALUES
    (1, 'Admin', 'ADMINISTRATEUR'), (2, 'Caissier', 'CAISSIER'), (3, 'Responsable', 'RESPONSABLE')`);
  db.run(`INSERT INTO cash_registers (id, code, nom, solde_initial, date_ouverture, seuil_alerte) VALUES
    (1, 'PRINC', 'Caisse principale', 100000, '2026-01-01', 20000),
    (2, 'ADMIN', 'Caisse administration', 0, '2026-01-01', 0)`);
  return {
    db,
    admin: { userId: 1, role: 'ADMINISTRATEUR', registerIds: [] },
    caissier: { userId: 2, role: 'CAISSIER', registerIds: [1] },
    responsable: { userId: 3, role: 'RESPONSABLE', registerIds: [1, 2] },
  };
}

test('totaux : revenus, dépenses, transferts neutres, mouvement de caisse', () => {
  const { db, caissier, responsable, admin } = setup();
  F.recordOperation(db, caissier, { registerId: 1, nature: 'revenu', categorie: 'Apports financiers', montant: 50000, date: '2026-02-10' });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Papier', montant: 20000, date: '2026-02-10' });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Internet', montant: 5000, date: '2026-02-11', modePaiement: 'virement' });
  F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 30000, date: '2026-02-12' });

  const s1 = R.summary(db, caissier, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(s1.revenus, 50000);
  assert.equal(s1.depenses, 25000, 'la dépense par virement compte dans les dépenses');
  assert.equal(s1.mouvementCaisse, 0, 'sur la caisse 1 : +50 000 -20 000 -30 000 (hors solde initial)');

  const s = R.summary(db, admin, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(s.transfertsNets, 0, 'un transfert est neutre sur l\'ensemble des caisses');
  assert.equal(s.mouvementCaisse, 30000, 'variation de caisse hors soldes initiaux');
});

test('correction : la dépense corrigée sort des totaux', () => {
  const { db, caissier, responsable } = setup();
  const d = F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Papier', montant: 20000, date: '2026-02-10' });
  F.correctTransaction(db, responsable, { transactionId: d.id, motif: 'erreur', date: '2026-02-10' });
  assert.equal(R.summary(db, responsable, { from: '2026-02-01', to: '2026-02-28' }).depenses, 0);
});

test('périodicité : la somme des séries mensuelles égale le total', () => {
  const { db, caissier, admin } = setup();
  F.recordOperation(db, caissier, { registerId: 1, nature: 'revenu', categorie: 'Autres revenus', montant: 1000, date: '2026-01-15' });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Papier', montant: 300, date: '2026-02-03' });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'revenu', categorie: 'Autres revenus', montant: 700, date: '2026-03-20' });
  const mois = R.series(db, admin, { from: '2026-01-01', to: '2026-03-31', granularite: 'mois' });
  assert.deepEqual(mois.map((m) => m.periode), ['2026-01', '2026-02', '2026-03']);
  const total = R.summary(db, admin, { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(mois.reduce((s, m) => s + m.revenus, 0), total.revenus);
  assert.equal(mois.reduce((s, m) => s + m.depenses, 0), total.depenses);
  const semaines = R.series(db, admin, { from: '2026-01-01', to: '2026-03-31', granularite: 'semaine' });
  assert.equal(semaines.find((w) => w.periode === '2026-01-12').revenus, 1000, 'lundi 12/01/2026 = semaine du 15/01');
});

test('périmètre : un caissier ne voit que ses caisses', () => {
  const { db, caissier, responsable } = setup();
  F.recordOperation(db, caissier, { registerId: 1, nature: 'revenu', categorie: 'Autres revenus', montant: 100, date: '2026-02-10' });
  F.recordOperation(db, responsable, { registerId: 2, nature: 'revenu', categorie: 'Autres revenus', montant: 9000, date: '2026-02-10' });
  assert.equal(R.summary(db, caissier, { from: '2026-02-01', to: '2026-02-28' }).revenus, 100);
  assert.throws(() => R.summary(db, caissier, { from: '2026-02-01', to: '2026-02-28', registerId: 2 }), (e) => e.code === 'ACCES_REFUSE');
  assert.equal(R.byRegister(db, caissier, { from: '2026-02-01', to: '2026-02-28' }).length, 1);
});

test('catégories, utilisateurs et fournisseurs', () => {
  const { db, caissier, responsable, admin } = setup();
  const f = M.createTiers(db, responsable, 'fournisseurs', { nom: 'Papeterie' });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Papier', montant: 1500, date: '2026-02-10', fournisseurId: f.id });
  F.recordOperation(db, responsable, { registerId: 1, nature: 'depense', categorie: 'Carburant', montant: 4000, date: '2026-02-11' });
  const cat = R.byCategory(db, admin, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(cat.map((c) => [c.categorie, c.total]), [['Carburant', 4000], ['Papier', 1500]]);
  const users = R.byUser(db, admin, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(users.find((u) => u.nom === 'Caissier').depenses, 1500);
  const sup = R.bySupplier(db, admin, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(sup.map((s) => [s.nom, s.total]), [['Papeterie', 1500]]);
});

test('commissions et clôtures : rapports cohérents avec les mouvements', () => {
  const { db, caissier, admin } = setup();
  const { id } = F.createCommission(db, admin, {
    reference: 'COM-1', periodeDebut: '2026-02-01', periodeFin: '2026-02-28', dateCalcul: '2026-03-01', montant: 100000,
  });
  F.collectCommission(db, admin, { commissionId: id, registerId: 1, montant: 40000, date: '2026-03-02' });
  const c = R.byCommission(db, admin, { from: '2026-03-01', to: '2026-03-31' })[0];
  assert.equal(c.encaisse, 40000);
  assert.equal(c.reste, 60000);

  F.recordOperation(db, caissier, { registerId: 1, nature: 'revenu', categorie: 'Autres revenus', montant: 1000, date: '2026-03-05' });
  F.closeDay(db, caissier, { registerId: 1, date: '2026-03-05', actual: 100500, explication: 'Pièce de 500 DA' });
  const rep = R.closingsReport(db, admin, { from: '2026-03-01', to: '2026-03-31' });
  // Ouverture du 05/03 = 100 000 + 40 000 (commission du 02/03) ; théorique = 140 000 + 1 000 = 141 000
  assert.equal(rep.lignes[0].solde_theorique, 141000);
  assert.equal(rep.lignes[0].ecart, 100500 - 141000);
  assert.equal(rep.nbEcarts, 1);
  assert.equal(rep.totalEcart, -40500);
});

test('tableau de bord : soldes, alertes et données réelles', () => {
  const { db, caissier, admin } = setup();
  // Seuil 20 000 : une dépense de 85 000 laisse 15 000 DA, donc alerte solde faible
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Loyer', montant: 85000, date: '2026-02-10' });
  const dash = R.dashboard(db, admin, { date: '2026-02-11' });
  assert.equal(dash.soldeGlobal, F.getGlobalBalance(db));
  assert.equal(dash.caisses.find((c) => c.id === 1).solde, 15000);
  assert.ok(dash.alertes.some((a) => a.type === 'solde_faible'));
  // Activité du 10/02 sans clôture : alerte de clôture manquante le 11/02
  assert.ok(dash.alertes.some((a) => a.type === 'cloture_manquante' && a.message.includes('10/02/2026')));
  F.closeDay(db, caissier, { registerId: 1, date: '2026-02-10', actual: 15000 });
  const apres = R.dashboard(db, admin, { date: '2026-02-11' });
  assert.ok(!apres.alertes.some((a) => a.type === 'cloture_manquante'));
  assert.equal(apres.depensesMois, 85000);
  assert.equal(apres.entreesJour, 0);
});

test('tableau de bord : budget et dépenses récurrentes à confirmer', () => {
  const { db, caissier, admin, responsable } = setup();
  M.setBudget(db, responsable, { registerId: 1, categorie: 'Papier', mois: '2026-02', montant: 50000 });
  F.recordOperation(db, caissier, { registerId: 1, nature: 'depense', categorie: 'Papier', montant: 40000, date: '2026-02-05' });
  M.createRecurring(db, responsable, {
    libelle: 'Loyer', categorie: 'Loyer', montant: 30000, frequence: 'mensuelle', prochaineEcheance: '2026-02-01', registerId: 1,
  });
  M.generateDueOccurrences(db, admin, '2026-02-01');
  const dash = R.dashboard(db, admin, { date: '2026-02-06' });
  assert.ok(dash.alertes.some((a) => a.type === 'budget' && a.niveau === 'avertissement'));
  assert.ok(dash.alertes.some((a) => a.type === 'recurrente_a_confirmer'));
  assert.equal(dash.commissions.calculees, 0);
});
