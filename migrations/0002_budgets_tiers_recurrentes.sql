-- MT Delivery — Gestion de caisse : fournisseurs, bénéficiaires, budgets, dépenses récurrentes (migration 0002)

ALTER TABLE transactions ADD COLUMN numero_facture TEXT;

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  telephone TEXT,
  email TEXT,
  adresse TEXT,
  categorie TEXT,
  description TEXT,
  actif INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE beneficiaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  telephone TEXT,
  email TEXT,
  adresse TEXT,
  categorie TEXT,
  description TEXT,
  actif INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budget mensuel par caisse et par catégorie de dépense.
CREATE TABLE budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  categorie TEXT NOT NULL,
  mois TEXT NOT NULL CHECK (mois GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  montant_initial INTEGER NOT NULL CHECK (montant_initial > 0),
  user_id INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (register_id, categorie, mois)
);

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  libelle TEXT NOT NULL,
  categorie TEXT NOT NULL,
  montant INTEGER NOT NULL CHECK (montant > 0),
  frequence TEXT NOT NULL CHECK (frequence IN ('quotidienne', 'hebdomadaire', 'mensuelle', 'annuelle')),
  prochaine_echeance TEXT NOT NULL,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  fournisseur_id INTEGER REFERENCES suppliers(id),
  beneficiaire_id INTEGER REFERENCES beneficiaries(id),
  mode_paiement TEXT NOT NULL DEFAULT 'especes',
  actif INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0, 1)),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Une échéance n'est jamais débitée seule : elle reste « proposée » jusqu'à confirmation.
CREATE TABLE recurring_expense_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recurring_id INTEGER NOT NULL REFERENCES recurring_expenses(id),
  echeance TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'proposee' CHECK (statut IN ('proposee', 'confirmee', 'ignoree')),
  transaction_id INTEGER REFERENCES transactions(id),
  decide_par INTEGER REFERENCES users(id),
  decide_le TEXT,
  UNIQUE (recurring_id, echeance)
);

CREATE TRIGGER recurrentes_occurrences_pas_de_suppression BEFORE DELETE ON recurring_expense_occurrences
BEGIN SELECT RAISE(ABORT, 'Echeances de depenses recurrentes non supprimables'); END;
