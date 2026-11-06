// Point d'entrée Cloudflare Workers — MT Delivery, Gestion de caisse.
// - /api/* : transmis à l'unique instance du Durable Object LedgerDO (journal financier sérialisé, SQLite).
// - le reste : fichiers statiques de l'interface (dossier public/, via Workers Static Assets).

import { DurableObject } from 'cloudflare:workers';
import api from './api.js';
import { storageAdapter } from './storage-adapter.js';
import { applyMigrations } from './migrate.js';
import m0001 from '../migrations/0001_noyau_financier.sql';
import m0002 from '../migrations/0002_budgets_tiers_recurrentes.sql';
import m0003 from '../migrations/0003_auth_parametres_notifications.sql';

const MIGRATIONS = [
  { nom: '0001_noyau_financier', sql: m0001 },
  { nom: '0002_budgets_tiers_recurrentes', sql: m0002 },
  { nom: '0003_auth_parametres_notifications', sql: m0003 },
];

const INSTANCE = 'mt-delivery-caisse';

export class LedgerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = storageAdapter(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(this.db, MIGRATIONS);
    });
  }

  async fetch(request) {
    return api.handle(request, this.db);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.LEDGER.get(env.LEDGER.idFromName(INSTANCE));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
