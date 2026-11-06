'use strict';

// Vérifie le chemin Durable Object (adaptateur synchrone + découpeur de migrations)
// en simulant son stockage SQL avec node:sqlite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { storageAdapter } = require('../src/storage-adapter');
const { applyMigrations, splitSql } = require('../src/migrate');

function fauxStockage() {
  const raw = new DatabaseSync(':memory:');
  const sql = {
    exec(requete, ...params) {
      const stmt = raw.prepare(requete);
      if (/^\s*(SELECT|WITH)/i.test(requete)) {
        const lignes = stmt.all(...params);
        return { toArray: () => lignes };
      }
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };
  return {
    sql,
    transactionSync(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    raw,
  };
}

const MIG = path.join(__dirname, '..', 'migrations');
const migrations = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ nom: f.replace('.sql', ''), sql: fs.readFileSync(path.join(MIG, f), 'utf8') }));

test('découpeur : les triggers gardent leur point-virgule interne', () => {
  const morceaux = splitSql(migrations[0].sql);
  const triggers = morceaux.filter((m) => /^CREATE TRIGGER/.test(m));
  assert.ok(triggers.length >= 6);
  for (const t of triggers) assert.match(t, /END$/);
  assert.ok(morceaux.every((m) => !m.startsWith('--')));
});

test('migrations appliquées une seule fois, journal immuable actif', () => {
  const stock = fauxStockage();
  const db = storageAdapter(stock);
  applyMigrations(db, migrations);
  applyMigrations(db, migrations); // second passage : rien à faire
  assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_migrations').n, migrations.length);
  db.run("INSERT INTO users (nom, email, role) VALUES ('U', 'u@mt.dz', 'ADMINISTRATEUR')");
  db.run("INSERT INTO cash_registers (code, nom, date_ouverture) VALUES ('C1', 'Caisse', '2026-01-01')");
  const r = db.run("INSERT INTO transactions (register_id, sens, nature, montant, date, user_id) VALUES (1, 'entree', 'revenu', 100, '2026-01-02', 1)");
  assert.equal(r.lastId, 1);
  assert.throws(() => db.run('UPDATE transactions SET montant = 1'), /immuable/);
});

test('transaction synchrone : annulation complète en cas d\'erreur', () => {
  const stock = fauxStockage();
  const db = storageAdapter(stock);
  applyMigrations(db, migrations);
  db.run("INSERT INTO users (nom, email, role) VALUES ('U', 'u@mt.dz', 'ADMINISTRATEUR')");
  db.run("INSERT INTO cash_registers (code, nom, date_ouverture) VALUES ('C1', 'Caisse', '2026-01-01')");
  assert.throws(() => db.transaction((tx) => {
    tx.run("INSERT INTO transactions (register_id, sens, nature, montant, date, user_id) VALUES (1, 'entree', 'revenu', 100, '2026-01-02', 1)");
    throw new Error('échec volontaire');
  }), /échec volontaire/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 0);
});
