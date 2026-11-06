'use strict';

// Routeur HTTP de MT Delivery — Gestion de caisse.
// Aucune logique métier ici : chaque route vérifie la session, lit la requête, appelle le moteur
// (finance, modules, reports, administration) et renvoie le résultat ou une erreur typée.

const F = require('./finance');
const M = require('./modules');
const R = require('./reports');
const A = require('./administration');
const auth = require('./auth');

const SESSION_COOKIE = 'mtc_session';
const TIERS = ['fournisseurs', 'beneficiaires'];
const STATUS_PAR_CODE = Object.freeze({
  ACCES_REFUSE: 403, ACTION_INTERDITE: 403, CONNEXION_INVALIDE: 401, COMPTE_VERROUILLE: 423,
  CAISSE_INTROUVABLE: 404, OPERATION_INTROUVABLE: 404, COMMISSION_INTROUVABLE: 404, TIERS_INTROUVABLE: 404,
  ECHEANCE_INTROUVABLE: 404, UTILISATEUR_INTROUVABLE: 404, NOTIFICATION_INTROUVABLE: 404, CLOTURE_INTROUVABLE: 404,
  DOUBLON: 409, PERIODE_CLOTUREE: 409, DEJA_CORRIGE: 409, DERNIER_ADMIN: 409, ECHEANCE_DEJA_TRAITEE: 409,
  DEJA_INITIALISE: 403, NON_CONNECTE: 401,
});

const routes = [];
function route(method, pattern, handler, options = {}) {
  const keys = [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]);
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '([^/]+)')}$`);
  routes.push({ method, re, keys, handler, publique: !!options.publique });
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const erreur = (status, code, message) => json({ error: { code, message } }, status);
const nombre = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const texteOuNull = (v) => (v === null || v === undefined || v === '' ? undefined : v);
const cookieSession = (token, expire = false) => `${SESSION_COOKIE}=${expire ? '' : token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${expire ? 0 : 43200}`;

function lireCookie(header, nom) {
  if (!header) return null;
  for (const morceau of header.split(';')) {
    const [k, ...v] = morceau.trim().split('=');
    if (k === nom) return v.join('=');
  }
  return null;
}

function assertTiers(kind) {
  if (!TIERS.includes(kind)) throw new F.FinanceError('INTROUVABLE', 'Ressource inconnue.');
  return kind;
}

// ---------- Session et initialisation ----------

route('POST', '/api/setup', async ({ db, body }) => {
  if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) throw new F.FinanceError('DEJA_INITIALISE', "L'application est déjà initialisée.");
  await A.createUser(db, A.SYSTEME, { nom: body.nom, email: body.email, password: body.password, role: 'ADMINISTRATEUR', registerIds: [] });
  return { ok: true };
}, { publique: true });

route('GET', '/api/etat', ({ db }) => ({ initialise: db.get('SELECT COUNT(*) AS n FROM users').n > 0 }), { publique: true });

route('POST', '/api/connexion', async ({ db, body }) => {
  const { token, user } = await auth.login(db, body);
  return json({ user }, 200, { 'set-cookie': cookieSession(token) });
}, { publique: true });

route('POST', '/api/deconnexion', async ({ db, token }) => {
  await auth.logout(db, token);
  return json({ ok: true }, 200, { 'set-cookie': cookieSession('', true) });
}, { publique: true });

route('GET', '/api/session', ({ actor }) => ({ user: actor }));

// ---------- Tableau de bord ----------

route('GET', '/api/tableau-de-bord', ({ db, actor, query }) => R.dashboard(db, actor, {
  date: texteOuNull(query.get('date')), registerId: nombre(query.get('registerId')),
}));

// ---------- Caisses ----------

route('GET', '/api/caisses', ({ db, actor }) => A.listRegisters(db, actor));
route('POST', '/api/caisses', ({ db, actor, body }) => A.createRegister(db, actor, body));
route('GET', '/api/caisses/:id', ({ db, actor, params }) => A.registerDetail(db, actor, Number(params.id)));
route('PUT', '/api/caisses/:id', ({ db, actor, params, body }) => A.updateRegister(db, actor, Number(params.id), body));
route('PUT', '/api/caisses/:id/utilisateurs', ({ db, actor, params, body }) => A.setRegisterUsers(db, actor, Number(params.id), body.userIds || []));

// ---------- Opérations, transferts, corrections ----------

route('GET', '/api/operations', ({ db, actor, query }) => A.listTransactions(db, actor, {
  from: texteOuNull(query.get('from')), to: texteOuNull(query.get('to')), registerId: nombre(query.get('registerId')),
  nature: texteOuNull(query.get('nature')), q: query.get('q') || '', limit: nombre(query.get('limit')) || 100, offset: nombre(query.get('offset')) || 0,
}));
route('POST', '/api/operations', ({ db, actor, body }) => F.recordOperation(db, actor, body));
route('POST', '/api/transferts', ({ db, actor, body }) => F.transfer(db, actor, body));
route('POST', '/api/operations/:id/corriger', ({ db, actor, params, body }) => F.correctTransaction(db, actor, {
  transactionId: Number(params.id), motif: body.motif, date: body.date || null,
}));

// ---------- Commissions ----------

route('GET', '/api/commissions', ({ db, actor, query }) => R.byCommission(db, actor, {
  from: texteOuNull(query.get('from')) || '0001-01-01', to: texteOuNull(query.get('to')) || '9999-12-31',
}));
route('POST', '/api/commissions', ({ db, actor, body }) => F.createCommission(db, actor, body));
route('POST', '/api/commissions/:id/encaissements', ({ db, actor, params, body }) => F.collectCommission(db, actor, {
  ...body, commissionId: Number(params.id),
}));
route('POST', '/api/commissions/import/apercu', ({ db, actor, body }) => A.analyserCommissions(db, actor, body.csv || ''));
route('POST', '/api/commissions/import', ({ db, actor, body }) => A.importerCommissions(db, actor, body.csv || ''));

// ---------- Fournisseurs et bénéficiaires ----------

route('GET', '/api/tiers/:kind', ({ db, actor, params, query }) => M.listTiers(db, actor, assertTiers(params.kind), { recherche: query.get('q') || '' }));
route('POST', '/api/tiers/:kind', ({ db, actor, params, body }) => M.createTiers(db, actor, assertTiers(params.kind), body));
route('GET', '/api/tiers/:kind/:id', ({ db, actor, params }) => M.tiersStats(db, actor, assertTiers(params.kind), Number(params.id)));
route('PUT', '/api/tiers/:kind/:id', ({ db, actor, params, body }) => M.updateTiers(db, actor, assertTiers(params.kind), Number(params.id), body));

// ---------- Budgets ----------

route('GET', '/api/budgets', ({ db, actor, query }) => A.budgetsList(db, actor, {
  registerId: nombre(query.get('registerId')), mois: query.get('mois') || F.todayAlgiers().slice(0, 7),
}));
route('POST', '/api/budgets', ({ db, actor, body }) => M.setBudget(db, actor, body));

// ---------- Dépenses récurrentes ----------

route('GET', '/api/recurrentes', ({ db, actor }) => A.recurringList(db, actor));
route('POST', '/api/recurrentes', ({ db, actor, body }) => M.createRecurring(db, actor, body));
route('POST', '/api/recurrentes/generer', ({ db, actor, body }) => M.generateDueOccurrences(db, actor, body.asOf || F.todayAlgiers()));
route('GET', '/api/echeances', ({ db, actor, query }) => M.listOccurrences(db, actor, { statut: texteOuNull(query.get('statut')) || null }));
route('POST', '/api/echeances/:id/confirmer', ({ db, actor, params, body }) => M.confirmOccurrence(db, actor, {
  occurrenceId: Number(params.id), date: body.date || null,
}));
route('POST', '/api/echeances/:id/ignorer', ({ db, actor, params }) => M.confirmOccurrence(db, actor, {
  occurrenceId: Number(params.id), ignorer: true,
}));

// ---------- Clôtures ----------

route('GET', '/api/clotures', ({ db, actor, query }) => R.closingsReport(db, actor, {
  from: texteOuNull(query.get('from')) || '0001-01-01', to: texteOuNull(query.get('to')) || '9999-12-31',
  registerId: nombre(query.get('registerId')),
}));
route('POST', '/api/clotures', ({ db, actor, body }) => F.closeDay(db, actor, body));
route('POST', '/api/clotures/reouverture', ({ db, actor, body }) => F.reopenDay(db, actor, body));
route('GET', '/api/clotures/rapport', ({ db, actor, query }) => new Response(
  A.rapportClotureHtml(db, actor, { registerId: Number(query.get('registerId')), date: query.get('date') }),
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
));

// ---------- Rapports ----------

route('GET', '/api/rapports/:type', ({ db, actor, params, query }) => {
  const p = {
    from: texteOuNull(query.get('from')) || '0001-01-01',
    to: texteOuNull(query.get('to')) || '9999-12-31',
    registerId: nombre(query.get('registerId')),
  };
  switch (params.type) {
    case 'resume': return R.summary(db, actor, p);
    case 'categories': return R.byCategory(db, actor, p);
    case 'utilisateurs': return R.byUser(db, actor, p);
    case 'fournisseurs': return R.bySupplier(db, actor, p);
    case 'caisses': return R.byRegister(db, actor, p);
    case 'periodes': return R.series(db, actor, { ...p, granularite: query.get('granularite') || 'mois' });
    case 'commissions': return R.byCommission(db, actor, p);
    case 'clotures': return R.closingsReport(db, actor, p);
    default: throw new F.FinanceError('INTROUVABLE', 'Rapport inconnu.');
  }
});

route('GET', '/api/export.csv', ({ db, actor, query }) => new Response(
  A.exporterCsv(db, actor, {
    from: texteOuNull(query.get('from')) || '0001-01-01', to: texteOuNull(query.get('to')) || '9999-12-31',
    registerId: nombre(query.get('registerId')),
  }),
  { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="mt-delivery-operations-${F.todayAlgiers()}.csv"`, 'cache-control': 'no-store' } },
));

// ---------- Utilisateurs, journal, paramètres ----------

route('GET', '/api/utilisateurs', ({ db, actor }) => A.listUsers(db, actor));
route('POST', '/api/utilisateurs', ({ db, actor, body }) => A.createUser(db, actor, body));
route('PUT', '/api/utilisateurs/:id', ({ db, actor, params, body }) => A.updateUser(db, actor, Number(params.id), body));
route('GET', '/api/journal', ({ db, actor, query }) => A.listAudit(db, actor, {
  from: texteOuNull(query.get('from')), to: texteOuNull(query.get('to')), action: texteOuNull(query.get('action')) || null,
}));
route('GET', '/api/parametres', ({ db }) => A.getSettings(db));
route('PUT', '/api/parametres', ({ db, actor, body }) => A.updateSettings(db, actor, body));

// ---------- Notifications ----------

route('GET', '/api/notifications', ({ db, actor, query }) => {
  const lue = query.get('lue');
  return A.listNotifications(db, actor, { lue: lue === null || lue === '' ? null : lue === '1' });
});
route('POST', '/api/notifications/:id/lue', ({ db, actor, params }) => A.marquerLue(db, actor, Number(params.id)));
route('POST', '/api/notifications/synchroniser', ({ db, actor }) => {
  if (actor.role !== 'ADMINISTRATEUR' && actor.role !== 'RESPONSABLE') throw new F.FinanceError('ACCES_REFUSE', 'Accès refusé pour cette action.');
  return { crees: A.syncNotifications(db) };
});

// ---------- Traitement de la requête ----------

async function handle(request, db) {
  const url = new URL(request.url);
  const chemin = url.pathname.replace(/\/+$/, '') || '/';
  const trouvee = routes.find((r) => r.method === request.method && r.re.test(chemin));
  if (!trouvee) return erreur(404, 'INTROUVABLE', 'Route inconnue.');
  const params = {};
  const m = trouvee.re.exec(chemin);
  trouvee.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  const token = lireCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const actor = await auth.loadActor(db, token);
  if (!trouvee.publique && !actor) return erreur(401, 'NON_CONNECTE', 'Connexion requise.');

  let body = {};
  if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return erreur(415, 'TYPE_INVALIDE', 'Le corps doit être du JSON.');
    try {
      body = await request.json();
    } catch {
      return erreur(400, 'JSON_INVALIDE', 'Corps JSON invalide.');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return erreur(400, 'JSON_INVALIDE', 'Le corps doit être un objet.');
  }

  try {
    const out = await trouvee.handler({ db, actor, token, body, params, query: url.searchParams });
    if (out instanceof Response) return out;
    return json(out ?? { ok: true });
  } catch (err) {
    if (err instanceof F.FinanceError) return erreur(STATUS_PAR_CODE[err.code] || 422, err.code, err.message);
    if (/immuable/i.test(err.message)) return erreur(409, 'JOURNAL_IMMUABLE', 'Opération interdite : le journal financier est immuable.');
    if (/UNIQUE constraint/i.test(err.message)) return erreur(409, 'DOUBLON', 'Doublon détecté.');
    console.error(err);
    return erreur(500, 'ERREUR_INTERNE', 'Erreur interne.');
  }
}

module.exports = { handle, routes };
