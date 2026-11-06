-- MT Delivery — Gestion de caisse : noyau financier (migration 0001)
-- Compatible SQLite et Cloudflare D1.
-- Montants : entiers en dinars algériens (DA, sans centimes). Aucun FLOAT.
-- Dates : TEXT au format AAAA-MM-JJ (fuseau Africa/Algiers).

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('ADMINISTRATEUR', 'RESPONSABLE', 'CAISSIER', 'CONSULTATION')),
  actif INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cash_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  nom TEXT NOT NULL,
  description TEXT,
  solde_initial INTEGER NOT NULL DEFAULT 0 CHECK (solde_initial >= 0),
  date_ouverture TEXT NOT NULL,
  responsable_id INTEGER REFERENCES users(id),
  seuil_alerte INTEGER NOT NULL DEFAULT 0 CHECK (seuil_alerte >= 0),
  statut TEXT NOT NULL DEFAULT 'active' CHECK (statut IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cash_register_users (
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (register_id, user_id)
);

-- Transferts : une ligne par transfert, reliée à ses deux mouvements.
CREATE TABLE cash_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES cash_registers(id),
  destination_id INTEGER NOT NULL REFERENCES cash_registers(id),
  montant INTEGER NOT NULL CHECK (montant > 0),
  date TEXT NOT NULL,
  description TEXT,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  transaction_sortie_id INTEGER,
  transaction_entree_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_id <> destination_id)
);

-- Journal financier : source de vérité des soldes. Append-only.
-- Une correction est une contre-écriture (nature = 'correction', corrige_id = origine).
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  sens TEXT NOT NULL CHECK (sens IN ('entree', 'sortie')),
  nature TEXT NOT NULL CHECK (nature IN ('revenu', 'depense', 'transfert', 'commission', 'correction')),
  categorie TEXT,
  montant INTEGER NOT NULL CHECK (montant > 0),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description TEXT,
  reference TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  affecte_caisse INTEGER NOT NULL DEFAULT 1 CHECK (affecte_caisse IN (0, 1)),
  mode_paiement TEXT,
  fournisseur_id INTEGER,
  beneficiaire_id INTEGER,
  transfert_id INTEGER REFERENCES cash_transfers(id),
  corrige_id INTEGER REFERENCES transactions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (register_id, reference)
);

CREATE UNIQUE INDEX uq_transactions_corrige ON transactions (corrige_id) WHERE corrige_id IS NOT NULL;
CREATE INDEX ix_transactions_caisse_date ON transactions (register_id, date);

CREATE TABLE commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  periode_debut TEXT NOT NULL,
  periode_fin TEXT NOT NULL,
  date_calcul TEXT NOT NULL,
  montant_calcule INTEGER NOT NULL CHECK (montant_calcule > 0),
  description TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Encaissements partiels et successifs. Seules les sommes encaissées alimentent une caisse.
CREATE TABLE commission_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commission_id INTEGER NOT NULL REFERENCES commissions(id),
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  montant INTEGER NOT NULL CHECK (montant > 0),
  date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE daily_closings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  date TEXT NOT NULL,
  solde_ouverture INTEGER NOT NULL,
  entrees INTEGER NOT NULL DEFAULT 0,
  sorties INTEGER NOT NULL DEFAULT 0,
  transferts_recus INTEGER NOT NULL DEFAULT 0,
  transferts_envoyes INTEGER NOT NULL DEFAULT 0,
  solde_theorique INTEGER NOT NULL,
  solde_reel INTEGER NOT NULL CHECK (solde_reel >= 0),
  ecart INTEGER NOT NULL,
  explication TEXT,
  statut TEXT NOT NULL CHECK (statut IN ('cloturee', 'reouverte')),
  cloture_par INTEGER NOT NULL REFERENCES users(id),
  cloture_le TEXT NOT NULL,
  reouverte_par INTEGER REFERENCES users(id),
  reouverte_le TEXT,
  motif_reouverture TEXT,
  UNIQUE (register_id, date),
  CHECK (ecart = solde_reel - solde_theorique)
);

-- Journal d'activité : jamais modifiable ni supprimable.
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entite TEXT NOT NULL,
  entite_id INTEGER,
  donnees_avant TEXT,
  donnees_apres TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Protections d'intégrité financière (append-only).
CREATE TRIGGER transactions_pas_de_modification BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'Journal financier immuable : modification interdite'); END;

CREATE TRIGGER transactions_pas_de_suppression BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'Journal financier immuable : suppression interdite'); END;

CREATE TRIGGER collections_pas_de_modification BEFORE UPDATE ON commission_collections
BEGIN SELECT RAISE(ABORT, 'Encaissements de commission immuables'); END;

CREATE TRIGGER collections_pas_de_suppression BEFORE DELETE ON commission_collections
BEGIN SELECT RAISE(ABORT, 'Encaissements de commission immuables'); END;

CREATE TRIGGER audit_pas_de_modification BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Journal d activite immuable'); END;

CREATE TRIGGER audit_pas_de_suppression BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Journal d activite immuable'); END;
