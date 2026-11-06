-- MT Delivery — Gestion de caisse : authentification, paramètres, notifications (migration 0003)

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN echecs_connexion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verrouille_jusqua TEXT;

-- Sessions : seul le hachage SHA-256 du jeton est stocké.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expire_le TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);

-- Notifications : créées par la synchronisation des alertes, une seule fois par clé.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  niveau TEXT NOT NULL CHECK (niveau IN ('info', 'avertissement', 'alerte')),
  message TEXT NOT NULL,
  lien TEXT,
  cle TEXT NOT NULL UNIQUE,
  lue INTEGER NOT NULL DEFAULT 0 CHECK (lue IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
