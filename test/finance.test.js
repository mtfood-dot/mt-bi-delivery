'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDatabase } = require('../src/db-node');
const F = require('../src/finance');

const MIGRATION = path.join(__dirname, '..', 'migrations', '0001_noyau_financier.sql');

function setup() {
  const db = openDatabase(':memory:');
  db.migrate(MIGRATION);
  db.migrate(path.join(__dirname, '..', 'migrations', '0002_budgets_tiers_recurrentes.sql'));
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

const entree = (db, actor, montant, date, extra = {}) => F.recordOperation(db, actor, {
  registerId: 1, nature: 'revenu', categorie: 'Apports financiers', montant, date, ...extra,
});
const depense = (db, actor, montant, date, extra = {}) => F.recordOperation(db, actor, {
  registerId: 1, nature: 'depense', categorie: 'Papier', montant, date, ...extra,
});

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof F.FinanceError && err.code === code);
}

// 1. Solde initial 100 000 + entrée 50 000 - dépense 20 000 = 130 000
test('1. solde = solde initial + entrées - dépenses', () => {
  const { db, caissier } = setup();
  entree(db, caissier, 50000, '2026-02-10');
  depense(db, caissier, 20000, '2026-02-10');
  assert.equal(F.getBalance(db, 1), 130000);
});

// 2. Transfert de 30 000 : solde global inchangé
test('2. un transfert ne modifie pas le solde global', () => {
  const { db, responsable } = setup();
  const globalAvant = F.getGlobalBalance(db);
  F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 30000, date: '2026-02-10', reference: 'TRF-1' });
  assert.equal(F.getBalance(db, 1), 70000);
  assert.equal(F.getBalance(db, 2), 30000);
  assert.equal(F.getGlobalBalance(db), globalAvant);
});

test('2b. transfert refusé si le solde source est insuffisant, sans écriture partielle', () => {
  const { db, responsable, db: d } = setup();
  expectCode(() => F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 999999, date: '2026-02-10' }), 'SOLDE_INSUFFISANT');
  assert.equal(d.get('SELECT COUNT(*) AS n FROM transactions').n, 0);
  assert.equal(d.get('SELECT COUNT(*) AS n FROM cash_transfers').n, 0);
});

// 3. Commission 100 000, encaissements 40 000 puis 35 000 : reste 25 000
test('3. encaissements partiels de commission successifs', () => {
  const { db, admin, responsable } = setup();
  const { id } = F.createCommission(db, admin, {
    reference: 'COM-2026-02', periodeDebut: '2026-02-01', periodeFin: '2026-02-28', dateCalcul: '2026-03-01', montant: 100000,
  });
  assert.equal(F.getBalance(db, 1), 100000, 'une commission calculée ne doit pas alimenter la caisse');

  const r1 = F.collectCommission(db, responsable, { commissionId: id, registerId: 1, montant: 40000, date: '2026-03-02' });
  assert.equal(r1.resteApres, 60000);
  const r2 = F.collectCommission(db, responsable, { commissionId: id, registerId: 1, montant: 35000, date: '2026-03-03' });
  assert.equal(r2.resteApres, 25000);
  assert.equal(F.getBalance(db, 1), 175000, 'seules les sommes encaissées alimentent la caisse');
  expectCode(() => F.collectCommission(db, responsable, { commissionId: id, registerId: 1, montant: 30000, date: '2026-03-04' }), 'DEPASSEMENT_COMMISSION');
});

// 4. Clôture avec écart de -2 000 : justification obligatoire
test('4. clôture : écart de -2 000 exige une explication', () => {
  const { db, caissier } = setup();
  entree(db, caissier, 50000, '2026-02-10');
  depense(db, caissier, 25000, '2026-02-10');
  // ouverture 100 000 + 50 000 - 25 000 = théorique 125 000 ; compté 123 000
  expectCode(() => F.closeDay(db, caissier, { registerId: 1, date: '2026-02-10', actual: 123000 }), 'EXPLICATION_REQUISE');
  const c = F.closeDay(db, caissier, { registerId: 1, date: '2026-02-10', actual: 123000, explication: 'Pièce de 2 000 DA non retrouvée' });
  assert.equal(c.theorique, 125000);
  assert.equal(c.ecart, -2000);
});

// 6. Dépense non payée en espèces : aucune sortie de caisse
test('6. dépense non payée en espèces ne réduit pas la caisse', () => {
  const { db, caissier } = setup();
  depense(db, caissier, 15000, '2026-02-10', { modePaiement: 'virement' });
  assert.equal(F.getBalance(db, 1), 100000);
  assert.equal(db.get('SELECT affecte_caisse FROM transactions').affecte_caisse, 0);
});

test('6b. dépense en espèces supérieure au solde refusée', () => {
  const { db, caissier } = setup();
  expectCode(() => depense(db, caissier, 150000, '2026-02-10'), 'SOLDE_INSUFFISANT');
});

// 7. Utilisateur non autorisé : accès refusé
test('7. accès refusé selon le rôle et la caisse', () => {
  const { db, caissier, consultation, responsable, admin } = setup();
  // Caissier sur une caisse non assignée
  expectCode(() => F.recordOperation(db, caissier, { registerId: 2, nature: 'revenu', categorie: 'Autres revenus', montant: 100, date: '2026-02-10' }), 'ACCES_REFUSE');
  // Consultation : lecture seule
  expectCode(() => entree(db, consultation, 100, '2026-02-10'), 'ACCES_REFUSE');
  expectCode(() => F.closeDay(db, consultation, { registerId: 1, date: '2026-02-10', actual: 100000 }), 'ACCES_REFUSE');
  // Caissier : pas de transfert, pas de commission, pas de correction, pas de réouverture
  expectCode(() => F.transfer(db, caissier, { sourceId: 1, destinationId: 2, montant: 100, date: '2026-02-10' }), 'ACCES_REFUSE');
  expectCode(() => F.createCommission(db, caissier, { reference: 'X', periodeDebut: '2026-02-01', periodeFin: '2026-02-02', dateCalcul: '2026-02-03', montant: 100 }), 'ACCES_REFUSE');
  entree(db, admin, 1000, '2026-02-10');
  const op = db.get('SELECT id FROM transactions LIMIT 1');
  expectCode(() => F.correctTransaction(db, caissier, { transactionId: op.id, motif: 'erreur', date: '2026-02-10' }), 'ACCES_REFUSE');
  F.closeDay(db, admin, { registerId: 1, date: '2026-02-10', actual: 101000 });
  expectCode(() => F.reopenDay(db, responsable, { registerId: 1, date: '2026-02-10', motif: 'test' }), 'ACCES_REFUSE');
});

// 8. Transaction en double : rejet
test('8. doublons rejetés (opérations et transferts)', () => {
  const { db, caissier, responsable } = setup();
  entree(db, caissier, 5000, '2026-02-10', { reference: 'REF-1' });
  expectCode(() => entree(db, caissier, 5000, '2026-02-10', { reference: 'REF-1' }), 'DOUBLON');
  F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 1000, date: '2026-02-10', reference: 'TRF-A' });
  expectCode(() => F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 1000, date: '2026-02-10', reference: 'TRF-A' }), 'DOUBLON');
});

test('8b. transfert vers la même caisse refusé', () => {
  const { db, responsable } = setup();
  expectCode(() => F.transfer(db, responsable, { sourceId: 1, destinationId: 1, montant: 100, date: '2026-02-10' }), 'TRANSFERT_MEME_CAISSE');
});

// 9. Correction : historique original conservé
test('9. correction par contre-écriture, original conservé', () => {
  const { db, caissier, responsable } = setup();
  const { id } = entree(db, caissier, 50000, '2026-02-10');
  assert.equal(F.getBalance(db, 1), 150000);
  const c = F.correctTransaction(db, responsable, { transactionId: id, motif: 'Montant saisi en double', date: '2026-02-10' });
  assert.equal(F.getBalance(db, 1), 100000);
  assert.equal(c.soldeApres, 100000);
  const orig = db.get('SELECT * FROM transactions WHERE id = ?', [id]);
  assert.equal(orig.montant, 50000);
  assert.equal(orig.nature, 'revenu');
  const rev = db.get('SELECT * FROM transactions WHERE corrige_id = ?', [id]);
  assert.equal(rev.nature, 'correction');
  assert.equal(rev.sens, 'sortie');
  expectCode(() => F.correctTransaction(db, responsable, { transactionId: id, motif: 'encore', date: '2026-02-10' }), 'DEJA_CORRIGE');
});

test('9b. le journal financier est immuable en base', () => {
  const { db, caissier } = setup();
  entree(db, caissier, 1000, '2026-02-10');
  assert.throws(() => db.run('UPDATE transactions SET montant = 1'), /immuable/);
  assert.throws(() => db.run('DELETE FROM transactions'), /immuable/);
  assert.throws(() => db.run('UPDATE audit_logs SET action = 1'), /immuable/);
});

// 10. Période clôturée : modification non autorisée
test('10. période clôturée protégée, réouverture admin tracée', () => {
  const { db, caissier, admin, responsable } = setup();
  entree(db, caissier, 1000, '2026-02-10');
  F.closeDay(db, caissier, { registerId: 1, date: '2026-02-10', actual: 101000 });
  expectCode(() => entree(db, caissier, 500, '2026-02-10'), 'PERIODE_CLOTUREE');
  expectCode(() => F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 100, date: '2026-02-10' }), 'PERIODE_CLOTUREE');
  expectCode(() => F.reopenDay(db, admin, { registerId: 1, date: '2026-02-10', motif: '   ' }), 'MOTIF_REQUIS');
  F.reopenDay(db, admin, { registerId: 1, date: '2026-02-10', motif: 'Oubli d\'une dépense' });
  entree(db, caissier, 500, '2026-02-10');
  const row = db.get("SELECT statut, reouverte_par, motif_reouverture FROM daily_closings WHERE date = '2026-02-10'");
  assert.equal(row.statut, 'reouverte');
  assert.equal(row.reouverte_par, 1);
  assert.equal(row.motif_reouverture, "Oubli d'une dépense");
});

test('audit : chaque action sensible laisse une trace', () => {
  const { db, caissier, responsable } = setup();
  entree(db, caissier, 1000, '2026-02-10');
  F.transfer(db, responsable, { sourceId: 1, destinationId: 2, montant: 100, date: '2026-02-10' });
  const actions = db.all('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action);
  assert.deepEqual(actions, ['creation_operation', 'transfert']);
});

test('montants invalides (négatifs, décimaux) refusés', () => {
  const { db, caissier } = setup();
  expectCode(() => entree(db, caissier, -10, '2026-02-10'), 'MONTANT_INVALIDE');
  expectCode(() => entree(db, caissier, 10.5, '2026-02-10'), 'MONTANT_INVALIDE');
  expectCode(() => entree(db, caissier, 10, '2026-13-40'), 'DATE_INVALIDE');
});
