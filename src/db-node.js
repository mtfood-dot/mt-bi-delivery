'use strict';

// Adaptateur SQLite (node:sqlite, intégré à Node 22). Même interface que le futur adaptateur D1 :
// all(sql, params), get(sql, params), run(sql, params) -> { lastId, changes }, transaction(fn), migrate(file).

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');

  const adapter = {
    raw,
    all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    // Transaction atomique : tout réussit ou rien n'est écrit.
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(adapter);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    migrate(file) {
      raw.exec(fs.readFileSync(file, 'utf8'));
    },
  };
  return adapter;
}

module.exports = { openDatabase };
