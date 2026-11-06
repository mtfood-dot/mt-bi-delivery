# MT Delivery — Gestion de caisse

Application web de trésorerie pour MT Delivery (Algérie, devise DA, fuseau Africa/Algiers, dates JJ/MM/AAAA).

## Fonctionnalités

- Tableau de bord avec indicateurs, alertes financières et graphiques SVG.
- Caisses multiples, affectation des utilisateurs, seuils d'alerte.
- Entrées, dépenses (mode de paiement, fournisseur, bénéficiaire, n° de facture), transferts atomiques entre caisses.
- Commissions : encaissements partiels et import CSV avec prévisualisation et détection des doublons.
- Fournisseurs et bénéficiaires avec historique et total payé.
- Budgets mensuels par catégorie (alertes à 80 %, 100 % et au-delà).
- Dépenses récurrentes : une échéance n'est jamais débitée sans confirmation.
- Clôtures quotidiennes avec écart obligatoirement expliqué, rapport imprimable, réouverture tracée (administrateur).
- Rapports (résumé, évolution, catégories, utilisateurs, fournisseurs, caisses, commissions, clôtures) et export CSV compatible Excel.
- Journal d'activité immuable, notifications, paramètres.
- Quatre rôles : ADMINISTRATEUR, RESPONSABLE, CAISSIER, CONSULTATION. Les permissions sont vérifiées côté serveur.

## Architecture

| Élément | Choix |
|---|---|
| Hébergement | Cloudflare Workers (fichiers statiques via `[assets]`) |
| Données | Durable Object `LedgerDO` avec SQLite (`ctx.storage.sql`) |
| Moteur financier | Synchrone, transactions `transactionSync`, journal append-only par triggers |
| Authentification | PBKDF2-SHA256, sessions hachées SHA-256, cookie HttpOnly / Secure / SameSite=Strict |
| Interface | HTML, CSS et JavaScript sans dépendance |

Voir `docs/` pour le détail : architecture, pages, base de données, règles financières, permissions, tests, sauvegardes.

## Développement local

Node.js 22 ou plus récent est requis (module `node:sqlite`).

```bash
npm test
```

Les 48 tests couvrent le moteur financier, les modules, les rapports, l'API (y compris verrouillage de compte, import CSV et scope des caissiers) et le stockage.

## Déploiement

Le dépôt est relié à Cloudflare : chaque push sur `main` déclenche `npx wrangler deploy`.

Première installation : ouvrez l'URL du site, créez le compte administrateur, puis ajoutez vos caisses et vos utilisateurs.

## Limites connues

- Pas de stockage de pièces jointes (justificatifs, photos de factures) : seul le numéro de facture est enregistré.
- Import des commissions au format CSV uniquement (pas de .xlsx).
- Le rapport de clôture est une page HTML imprimable (Ctrl+P → PDF), pas un fichier PDF généré.
- Export Excel : fichier CSV en UTF-8 avec BOM, séparateur « ; ».
- Notifications visibles par l'administrateur et le responsable uniquement.
