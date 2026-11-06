'use strict';

// Adaptateur SQL synchrone pour le stockage SQLite d'un Durable Object Cloudflare.
// Même interface que l'adaptateur node:sqlite (src/db-node.js) : le moteur financier est identique.
// transaction() utilise transactionSync : tout réussit ou rien n'est écrit.

function storageAdapter(storage) {
  const sql = storage.sql;
  const adapter = {
    all(requete, params = []) {
      return sql.exec(requete, ...params).toArray();
    },
    get(requete, params = []) {
      return sql.exec(requete, ...params).toArray()[0];
    },
    run(requete, params = []) {
      sql.exec(requete, ...params);
      const r = sql.exec('SELECT last_insert_rowid() AS id, changes() AS ch').toArray()[0];
      return { lastId: Number(r.id), changes: Number(r.ch) };
    },
    transaction(fn) {
      return storage.transactionSync(() => fn(adapter));
    },
  };
  return adapter;
}

module.exports = { storageAdapter };
