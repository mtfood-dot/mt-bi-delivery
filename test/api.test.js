'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/db-node');
const { applyMigrations } = require('../src/migrate');
const api = require('../src/api');

const MIG = path.join(__dirname, '..', 'migrations');
const MIGRATIONS = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ nom: f.replace('.sql', ''), sql: fs.readFileSync(path.join(MIG, f), 'utf8') }));

const PASS = 'MotDePasse-2026!';
let db;
let cookieAdmin;

const URL_BASE = 'https://caisse.test';
async function appel(method, chemin, { corps, cookie, brut } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (corps !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(corps); }
  if (brut !== undefined) { headers['content-type'] = 'text/plain'; body = brut; }
  const res = await api.handle(new Request(URL_BASE + chemin, { method, headers, body }), db);
  const texte = await res.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* réponse non JSON */ }
  return { status: res.status, json, texte, headers: res.headers };
}

before(async () => {
  db = openDatabase(':memory:');
  applyMigrations(db, MIGRATIONS);
});

test('initialisation : un seul premier compte administrateur', async () => {
  const bad = await appel('POST', '/api/setup', { corps: { nom: 'Admin', email: 'admin@mt.dz', password: 'court' } });
  assert.equal(bad.status, 422);
  const ok = await appel('POST', '/api/setup', { corps: { nom: 'Admin', email: 'admin@mt.dz', password: PASS } });
  assert.equal(ok.status, 200);
  const again = await appel('POST', '/api/setup', { corps: { nom: 'X', email: 'x@mt.dz', password: PASS } });
  assert.equal(again.status, 403);
  assert.equal(again.json.error.code, 'DEJA_INITIALISE');
});

test('connexion : refus, mauvais mot de passe, cookie HttpOnly', async () => {
  const sans = await appel('GET', '/api/session');
  assert.equal(sans.status, 401);
  const mauvais = await appel('POST', '/api/connexion', { corps: { email: 'admin@mt.dz', password: 'faux-mot-de-passe' } });
  assert.equal(mauvais.status, 401);
  const ok = await appel('POST', '/api/connexion', { corps: { email: 'admin@mt.dz', password: PASS } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  cookieAdmin = cookie.split(';')[0];
  const session = await appel('GET', '/api/session', { cookie: cookieAdmin });
  assert.equal(session.json.user.role, 'ADMINISTRATEUR');
});

test('verrouillage après 6 échecs', async () => {
  db.run("INSERT INTO users (nom, email, role, password_hash) VALUES ('Verrou', 'verrou@mt.dz', 'CONSULTATION', (SELECT password_hash FROM users WHERE email = 'admin@mt.dz'))");
  let dernier;
  for (let i = 0; i < 6; i++) dernier = await appel('POST', '/api/connexion', { corps: { email: 'verrou@mt.dz', password: 'x' } });
  assert.equal(dernier.status, 401);
  const bloque = await appel('POST', '/api/connexion', { corps: { email: 'verrou@mt.dz', password: PASS } });
  assert.equal(bloque.status, 423);
});

test('format des requêtes : JSON et type de contenu obligatoires', async () => {
  const brut = await appel('POST', '/api/caisses', { cookie: cookieAdmin, brut: 'texte' });
  assert.equal(brut.status, 415);
  const invalide = await appel('POST', '/api/caisses', { cookie: cookieAdmin, brut: '{pas du json' });
  assert.equal(invalide.status, 415);
  const inconnue = await appel('GET', '/api/inexistant', { cookie: cookieAdmin });
  assert.equal(inconnue.status, 404);
});

test('caisses, opérations, transferts, corrections via l\'API', async () => {
  const c1 = await appel('POST', '/api/caisses', { cookie: cookieAdmin, corps: { code: 'princ', nom: 'Caisse principale', soldeInitial: 100000, dateOuverture: '2026-01-01' } });
  assert.equal(c1.status, 200);
  const c2 = await appel('POST', '/api/caisses', { cookie: cookieAdmin, corps: { code: 'admin', nom: 'Caisse administration', dateOuverture: '2026-01-01' } });
  const r1 = c1.json.id;
  const r2 = c2.json.id;

  const revenu = await appel('POST', '/api/operations', { cookie: cookieAdmin, corps: {
    registerId: r1, nature: 'revenu', categorie: 'Apports financiers', montant: 50000, date: '2026-02-10', reference: 'R-1',
  } });
  assert.equal(revenu.status, 200);

  const trop = await appel('POST', '/api/operations', { cookie: cookieAdmin, corps: {
    registerId: r1, nature: 'depense', categorie: 'Papier', montant: 999999, date: '2026-02-10',
  } });
  assert.equal(trop.status, 422);
  assert.equal(trop.json.error.code, 'SOLDE_INSUFFISANT');

  const tr = await appel('POST', '/api/transferts', { cookie: cookieAdmin, corps: {
    sourceId: r1, destinationId: r2, montant: 30000, date: '2026-02-11',
  } });
  assert.equal(tr.status, 200);

  const liste = await appel('GET', `/api/operations?registerId=${r1}&from=2026-02-01&to=2026-02-28`, { cookie: cookieAdmin });
  assert.equal(liste.json.total, 2);

  const corr = await appel('POST', `/api/operations/${revenu.json.id}/corriger`, { cookie: cookieAdmin, corps: { motif: 'saisie en double', date: '2026-02-12' } });
  assert.equal(corr.status, 200);

  const dash = await appel('GET', '/api/tableau-de-bord?date=2026-02-12', { cookie: cookieAdmin });
  assert.equal(dash.json.soldeGlobal, 100000 + 0 + 50000 - 50000);
});

test('clôture : écart exige une explication, rapport HTML disponible', async () => {
  const caisse = db.get("SELECT id FROM cash_registers WHERE code = 'PRINC'").id;
  // Le 10/02 : ouverture 100 000 + revenu 50 000 = théorique 150 000
  const ecartSansExplication = await appel('POST', '/api/clotures', { cookie: cookieAdmin, corps: { registerId: caisse, date: '2026-02-10', actual: 148000 } });
  assert.equal(ecartSansExplication.json.error.code, 'EXPLICATION_REQUISE');
  const sans = await appel('POST', '/api/clotures', { cookie: cookieAdmin, corps: { registerId: caisse, date: '2026-02-10', actual: 150000 } });
  assert.equal(sans.status, 200, 'écart nul : pas d\'explication requise');
  const dejaFaite = await appel('POST', '/api/clotures', { cookie: cookieAdmin, corps: { registerId: caisse, date: '2026-02-10', actual: 150000 } });
  assert.equal(dejaFaite.status, 409);
  const rapport = await appel('GET', `/api/clotures/rapport?registerId=${caisse}&date=2026-02-10`, { cookie: cookieAdmin });
  assert.match(rapport.texte, /Rapport de clôture/);
  assert.match(rapport.headers.get('content-type'), /text\/html/);
});

test('import CSV des commissions : prévisualisation, doublons, confirmation', async () => {
  const csv = [
    'reference;periode_debut;periode_fin;date_calcul;montant;description',
    'COM-1;2026-02-01;2026-02-28;2026-03-01;100000;"Mars, lot 1"',
    'COM-1;2026-02-01;2026-02-28;2026-03-01;100000;doublon dans le fichier',
    'COM-2;2026-02-01;2026-02-28;2026-03-01;abc;montant invalide',
  ].join('\n');
  const apercu = await appel('POST', '/api/commissions/import/apercu', { cookie: cookieAdmin, corps: { csv } });
  assert.equal(apercu.json.pretes, 1);
  assert.equal(apercu.json.doublons, 1);
  assert.equal(apercu.json.erreurs, 1);
  const imp = await appel('POST', '/api/commissions/import', { cookie: cookieAdmin, corps: { csv } });
  assert.equal(imp.json.importees, 1);
  const again = await appel('POST', '/api/commissions/import', { cookie: cookieAdmin, corps: { csv } });
  assert.equal(again.json.importees, 0);
  assert.equal(again.json.doublonsIgnores, 2);
  const liste = await appel('GET', '/api/commissions', { cookie: cookieAdmin });
  assert.equal(liste.json.length, 1);
  assert.equal(liste.json[0].montant_calcule, 100000);
});

test('export CSV compatible Excel (BOM, séparateur point-virgule)', async () => {
  // Response.text() retire le BOM : on lit les octets bruts.
  const res = await api.handle(new Request(`${URL_BASE}/api/export.csv?from=2026-01-01&to=2026-12-31`, { headers: { cookie: cookieAdmin } }), db);
  assert.equal(res.status, 200);
  const octets = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([octets[0], octets[1], octets[2]], [0xef, 0xbb, 0xbf]);
  assert.match(new TextDecoder().decode(octets.slice(3)), /Date;Caisse;Nature/);
});

test('utilisateurs : caissier limité, mot de passe haché, pas de données d\'autres caisses', async () => {
  const caisse1 = db.get("SELECT id FROM cash_registers WHERE code = 'PRINC'").id;
  const creation = await appel('POST', '/api/utilisateurs', { cookie: cookieAdmin, corps: {
    nom: 'Karim Caissier', email: 'karim@mt.dz', role: 'CAISSIER', password: PASS, registerIds: [caisse1],
  } });
  assert.equal(creation.status, 200);
  const stocke = db.get("SELECT password_hash FROM users WHERE email = 'karim@mt.dz'").password_hash;
  assert.match(stocke, /^pbkdf2\$/);
  assert.ok(!stocke.includes(PASS));

  const login = await appel('POST', '/api/connexion', { corps: { email: 'karim@mt.dz', password: PASS } });
  const cookieCaissier = login.headers.get('set-cookie').split(';')[0];
  const utilisateurs = await appel('GET', '/api/utilisateurs', { cookie: cookieCaissier });
  assert.equal(utilisateurs.status, 403);
  const journal = await appel('GET', '/api/journal', { cookie: cookieCaissier });
  assert.equal(journal.status, 403);
  const caisses = await appel('GET', '/api/caisses', { cookie: cookieCaissier });
  assert.equal(caisses.json.length, 1);
  const autre = await appel('GET', `/api/caisses/${db.get("SELECT id FROM cash_registers WHERE code = 'ADMIN'").id}`, { cookie: cookieCaissier });
  assert.equal(autre.status, 403);
});

test('paramètres et journal : admin seulement, journal consultable', async () => {
  const p = await appel('PUT', '/api/parametres', { cookie: cookieAdmin, corps: { societe_nom: 'MT Delivery SARL', devise: 'DA' } });
  assert.equal(p.json.societe_nom, 'MT Delivery SARL');
  const journal = await appel('GET', '/api/journal', { cookie: cookieAdmin });
  assert.ok(journal.json.length > 0);
  assert.ok(journal.json.some((a) => a.action === 'import_commission'));
});

test('notifications : synchronisation unique et lecture', async () => {
  const premiere = await appel('POST', '/api/notifications/synchroniser', { cookie: cookieAdmin, corps: {} });
  assert.ok(premiere.json.crees >= 0);
  const seconde = await appel('POST', '/api/notifications/synchroniser', { cookie: cookieAdmin, corps: {} });
  assert.equal(seconde.json.crees, 0, 'une même notification n\'est créée qu\'une fois');
  const liste = await appel('GET', '/api/notifications?lue=0', { cookie: cookieAdmin });
  if (liste.json.length > 0) {
    const lu = await appel('POST', `/api/notifications/${liste.json[0].id}/lue`, { cookie: cookieAdmin, corps: {} });
    assert.equal(lu.status, 200);
  }
});

test('rapports et export : chaque rapport répond', async () => {
  for (const type of ['resume', 'categories', 'utilisateurs', 'fournisseurs', 'caisses', 'periodes', 'commissions', 'clotures']) {
    const res = await appel('GET', `/api/rapports/${type}?from=2026-01-01&to=2026-12-31`, { cookie: cookieAdmin });
    assert.equal(res.status, 200, type);
  }
});
