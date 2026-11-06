'use strict';

// Applique les migrations SQL une seule fois, chacune dans sa propre transaction.
// Découpe en instructions sans dépendre d'un parseur : les lignes de commentaire sont retirées,
// puis le texte est coupé sur « ; » suivi d'un retour à la ligne (les triggers gardent leur « ; » interne).

function splitSql(texte) {
  const sansCommentaires = String(texte).split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return sansCommentaires
    .split(/;\s*\n|;\s*$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function applyMigrations(db, migrations) {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const m of migrations) {
    if (db.get('SELECT nom FROM schema_migrations WHERE nom = ?', [m.nom])) continue;
    db.transaction((tx) => {
      for (const instruction of splitSql(m.sql)) tx.run(instruction);
      tx.run('INSERT INTO schema_migrations (nom) VALUES (?)', [m.nom]);
    });
  }
}

module.exports = { splitSql, applyMigrations };
