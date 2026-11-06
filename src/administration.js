'use strict';

// Administration : utilisateurs, caisses, paramètres, journal d'activité, notifications,
// listes (opérations, budgets, récurrentes), import CSV des commissions, exports et rapport de clôture.
// Toutes les actions passent par les mêmes contrôles de droits que le noyau financier.

const F = require('./finance');
const M = require('./modules');
const R = require('./reports');
const auth = require('./auth');

const SYSTEME = Object.freeze({ userId: null, nom: 'Système', role: 'ADMINISTRATEUR', registerIds: [] });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (code, message) => { throw new F.FinanceError(code, message); };

function texte(valeur, champ) {
  const v = typeof valeur === 'string' ? valeur.trim() : '';
  if (!v) fail('CHAMP_REQUIS', `${champ} est obligatoire.`);
  return v;
}

function entierPositif(valeur, champ) {
  if (!Number.isInteger(valeur) || valeur <= 0) fail('MONTANT_INVALIDE', `${champ} doit être un entier positif (DA).`);
  return valeur;
}

function assertCaisseExiste(db, id) {
  if (!db.get('SELECT id FROM cash_registers WHERE id = ?', [id])) fail('CAISSE_INTROUVABLE', 'Caisse introuvable.');
}

// ---------- Utilisateurs ----------

async function createUser(db, actor, data) {
  F.requirePermission(actor, 'utilisateurs');
  const nom = texte(data.nom, 'Le nom');
  const email = texte(data.email, "L'adresse e-mail").toLowerCase();
  if (!EMAIL.test(email)) fail('EMAIL_INVALIDE', 'Adresse e-mail invalide.');
  if (!F.ROLES.includes(data.role)) fail('ROLE_INVALIDE', 'Rôle invalide.');
  const hash = await auth.hashPassword(data.password);
  const registerIds = Array.isArray(data.registerIds) ? data.registerIds.map(Number) : [];
  return db.transaction((tx) => {
    if (tx.get('SELECT id FROM users WHERE lower(email) = ?', [email])) fail('DOUBLON', 'Cette adresse e-mail existe déjà.');
    registerIds.forEach((rid) => assertCaisseExiste(tx, rid));
    const id = tx.run('INSERT INTO users (nom, email, role, password_hash) VALUES (?, ?, ?, ?)', [nom, email, data.role, hash]).lastId;
    for (const rid of registerIds) tx.run('INSERT OR IGNORE INTO cash_register_users (register_id, user_id) VALUES (?, ?)', [rid, id]);
    F.audit(tx, actor, 'creation_utilisateur', 'users', id, null, { email, role: data.role, registerIds });
    return { id };
  });
}

async function updateUser(db, actor, id, data) {
  F.requirePermission(actor, 'utilisateurs');
  const hash = data.password ? await auth.hashPassword(data.password) : null;
  return db.transaction((tx) => {
    const avant = tx.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!avant) fail('UTILISATEUR_INTROUVABLE', 'Utilisateur introuvable.');
    const role = data.role ?? avant.role;
    const actif = data.actif ?? !!avant.actif;
    if (!F.ROLES.includes(role)) fail('ROLE_INVALIDE', 'Rôle invalide.');
    if (id === actor.userId && (!actif || role !== 'ADMINISTRATEUR')) {
      fail('ACTION_INTERDITE', 'Vous ne pouvez pas retirer vos propres droits d\'administrateur ni désactiver votre compte.');
    }
    if (avant.role === 'ADMINISTRATEUR' && (role !== 'ADMINISTRATEUR' || !actif)) {
      const autres = tx.get("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMINISTRATEUR' AND actif = 1 AND id <> ?", [id]).n;
      if (autres === 0) fail('DERNIER_ADMIN', 'Il doit rester au moins un administrateur actif.');
    }
    tx.run('UPDATE users SET nom = ?, role = ?, actif = ? WHERE id = ?', [data.nom?.trim() || avant.nom, role, actif ? 1 : 0, id]);
    if (hash) tx.run('UPDATE users SET password_hash = ?, echecs_connexion = 0, verrouille_jusqua = NULL WHERE id = ?', [hash, id]);
    if (!actif) tx.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    if (Array.isArray(data.registerIds)) {
      tx.run('DELETE FROM cash_register_users WHERE user_id = ?', [id]);
      for (const rid of data.registerIds.map(Number)) {
        assertCaisseExiste(tx, rid);
        tx.run('INSERT INTO cash_register_users (register_id, user_id) VALUES (?, ?)', [rid, id]);
      }
    }
    F.audit(tx, actor, 'modification_utilisateur', 'users', id,
      { role: avant.role, actif: !!avant.actif }, { role, actif, mot_de_passe_modifie: !!hash });
    return { id };
  });
}

function listUsers(db, actor) {
  F.requirePermission(actor, 'utilisateurs');
  return db.all(
    `SELECT u.id, u.nom, u.email, u.role, u.actif, u.verrouille_jusqua,
            (SELECT COALESCE(GROUP_CONCAT(register_id), '') FROM cash_register_users c WHERE c.user_id = u.id) AS caisses
     FROM users u ORDER BY u.nom`,
  ).map((u) => ({ ...u, actif: !!u.actif, registerIds: u.caisses ? u.caisses.split(',').map(Number) : [] }));
}

// ---------- Caisses ----------

function createRegister(db, actor, data) {
  F.requirePermission(actor, 'caisses');
  const code = texte(data.code, 'Le code').toUpperCase();
  const nom = texte(data.nom, 'Le nom');
  const solde = data.soldeInitial ?? 0;
  if (!Number.isInteger(solde) || solde < 0) fail('MONTANT_INVALIDE', 'Le solde initial doit être un entier positif ou nul (DA).');
  if (!F.isValidDate(data.dateOuverture)) fail('DATE_INVALIDE', "Date d'ouverture invalide.");
  const seuil = data.seuilAlerte ?? 0;
  if (!Number.isInteger(seuil) || seuil < 0) fail('MONTANT_INVALIDE', "Le seuil d'alerte doit être un entier positif ou nul.");
  return db.transaction((tx) => {
    if (tx.get('SELECT id FROM cash_registers WHERE code = ?', [code])) fail('DOUBLON', 'Ce code de caisse existe déjà.');
    const id = tx.run(
      `INSERT INTO cash_registers (code, nom, description, solde_initial, date_ouverture, responsable_id, seuil_alerte)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, nom, data.description || null, solde, data.dateOuverture, data.responsableId || null, seuil],
    ).lastId;
    for (const uid of (data.userIds || []).map(Number)) tx.run('INSERT OR IGNORE INTO cash_register_users (register_id, user_id) VALUES (?, ?)', [id, uid]);
    F.audit(tx, actor, 'creation_caisse', 'cash_registers', id, null, { code, nom, solde });
    return { id };
  });
}

function updateRegister(db, actor, id, data) {
  F.requirePermission(actor, 'caisses');
  return db.transaction((tx) => {
    const avant = tx.get('SELECT * FROM cash_registers WHERE id = ?', [id]);
    if (!avant) fail('CAISSE_INTROUVABLE', 'Caisse introuvable.');
    let solde = avant.solde_initial;
    if (data.soldeInitial !== undefined && data.soldeInitial !== avant.solde_initial) {
      const mouvements = tx.get('SELECT COUNT(*) AS n FROM transactions WHERE register_id = ?', [id]).n;
      if (mouvements > 0) fail('SOLDE_INITIAL_FIGE', 'Le solde initial ne peut plus être modifié : la caisse a déjà des mouvements.');
      if (!Number.isInteger(data.soldeInitial) || data.soldeInitial < 0) fail('MONTANT_INVALIDE', 'Solde initial invalide.');
      solde = data.soldeInitial;
    }
    const statut = data.statut ?? avant.statut;
    if (!['active', 'inactive'].includes(statut)) fail('STATUT_INVALIDE', 'Statut invalide.');
    tx.run(
      `UPDATE cash_registers SET nom = ?, description = ?, solde_initial = ?, seuil_alerte = ?, statut = ?, responsable_id = ? WHERE id = ?`,
      [data.nom?.trim() || avant.nom, data.description ?? avant.description, solde, data.seuilAlerte ?? avant.seuil_alerte,
        statut, data.responsableId === undefined ? avant.responsable_id : data.responsableId, id],
    );
    F.audit(tx, actor, 'modification_caisse', 'cash_registers', id,
      { nom: avant.nom, statut: avant.statut, solde_initial: avant.solde_initial }, { nom: data.nom, statut, solde_initial: solde });
    return { id };
  });
}

function setRegisterUsers(db, actor, id, userIds) {
  F.requirePermission(actor, 'caisses');
  return db.transaction((tx) => {
    assertCaisseExiste(tx, id);
    tx.run('DELETE FROM cash_register_users WHERE register_id = ?', [id]);
    for (const uid of userIds.map(Number)) tx.run('INSERT INTO cash_register_users (register_id, user_id) VALUES (?, ?)', [id, uid]);
    F.audit(tx, actor, 'affectation_utilisateurs_caisse', 'cash_registers', id, null, { userIds });
    return { id };
  });
}

function listRegisters(db, actor) {
  const ids = R.scopeIds(db, actor);
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  return db.all(`SELECT * FROM cash_registers WHERE id IN (${marks}) ORDER BY nom`, ids)
    .map((r) => ({ ...r, soldeActuel: F.getBalance(db, r.id) }));
}

function registerDetail(db, actor, id) {
  F.requirePermission(actor, 'lire', id);
  const reg = db.get('SELECT * FROM cash_registers WHERE id = ?', [id]);
  if (!reg) fail('CAISSE_INTROUVABLE', 'Caisse introuvable.');
  const totaux = R.summary(db, actor, { from: '0001-01-01', to: '9999-12-31', registerId: id });
  const virements = db.get(
    `SELECT COALESCE(SUM(CASE WHEN sens = 'entree' THEN montant END), 0) AS recus,
            COALESCE(SUM(CASE WHEN sens = 'sortie' THEN montant END), 0) AS envoyes
     FROM transactions WHERE register_id = ? AND nature = 'transfert'`,
    [id],
  );
  return {
    caisse: { ...reg, soldeActuel: F.getBalance(db, id) },
    totaux,
    transfertsRecus: virements.recus,
    transfertsEnvoyes: virements.envoyes,
    utilisateurs: db.all(
      `SELECT u.id, u.nom, u.role FROM cash_register_users c JOIN users u ON u.id = c.user_id WHERE c.register_id = ? ORDER BY u.nom`,
      [id],
    ),
    clotures: db.all('SELECT * FROM daily_closings WHERE register_id = ? ORDER BY date DESC LIMIT 30', [id]),
    operations: listTransactions(db, actor, { registerId: id, limit: 100 }).lignes,
  };
}

// ---------- Journal de caisse (liste des opérations) ----------

function listTransactions(db, actor, { from = '0001-01-01', to = '9999-12-31', registerId = null, nature = null, q = '', limit = 100, offset = 0, toutes = false } = {}) {
  const ids = R.scopeIds(db, actor, registerId);
  if (ids.length === 0) return { lignes: [], total: 0 };
  const marks = ids.map(() => '?').join(',');
  const params = [...ids, from, to];
  let cond = '';
  if (nature) { cond += ' AND t.nature = ?'; params.push(nature); }
  if (q && q.trim()) {
    cond += ' AND (t.description LIKE ? OR t.reference LIKE ? OR t.categorie LIKE ? OR t.numero_facture LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  const base = `FROM transactions t JOIN cash_registers r ON r.id = t.register_id JOIN users u ON u.id = t.user_id
    WHERE t.register_id IN (${marks}) AND t.date BETWEEN ? AND ? ${cond}`;
  const total = db.get(`SELECT COUNT(*) AS n ${base}`, params).n;
  const lim = toutes ? -1 : Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const lignes = db.all(
    `SELECT t.id, t.date, t.sens, t.nature, t.categorie, t.montant, t.description, t.reference, t.affecte_caisse,
            t.mode_paiement, t.numero_facture, t.corrige_id, t.created_at, r.nom AS caisse, u.nom AS utilisateur, t.register_id
     ${base} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );
  return { lignes, total };
}

function budgetsList(db, actor, { registerId = null, mois }) {
  const ids = R.scopeIds(db, actor, registerId);
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  return db.all(`SELECT register_id, categorie FROM budgets WHERE register_id IN (${marks}) AND mois = ? ORDER BY register_id, categorie`, [...ids, mois])
    .map((b) => M.budgetStatus(db, actor, b.register_id, b.categorie, mois));
}

function recurringList(db, actor) {
  const ids = R.scopeIds(db, actor);
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  return db.all(`SELECT * FROM recurring_expenses WHERE register_id IN (${marks}) ORDER BY libelle`, ids);
}

// ---------- Paramètres ----------

const CLES_PARAMETRES = Object.freeze(['societe_nom', 'societe_adresse', 'societe_telephone', 'devise', 'fuseau_horaire', 'format_date']);

function getSettings(db) {
  const rows = db.all('SELECT cle, valeur FROM settings');
  const defauts = { societe_nom: 'MT Delivery', devise: 'DA', fuseau_horaire: 'Africa/Algiers', format_date: 'DD/MM/YYYY' };
  const out = { ...defauts };
  for (const r of rows) out[r.cle] = r.valeur;
  return out;
}

function updateSettings(db, actor, data) {
  F.requirePermission(actor, 'parametres');
  return db.transaction((tx) => {
    const avant = getSettings(tx);
    for (const cle of CLES_PARAMETRES) {
      if (data[cle] === undefined) continue;
      const valeur = String(data[cle]).trim();
      tx.run('INSERT INTO settings (cle, valeur) VALUES (?, ?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur', [cle, valeur]);
    }
    F.audit(tx, actor, 'modification_parametres', 'settings', null, null, data);
    return getSettings(tx);
  });
}

// ---------- Journal d'activité ----------

function listAudit(db, actor, { from = '0001-01-01', to = '9999-12-31', action = null, limit = 200 } = {}) {
  F.requirePermission(actor, 'journal');
  const params = [from, to + 'T23:59:59'];
  let cond = '';
  if (action) { cond = ' AND a.action = ?'; params.push(action); }
  return db.all(
    `SELECT a.id, a.created_at, a.action, a.entite, a.entite_id, a.donnees_avant, a.donnees_apres, u.nom AS utilisateur
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.created_at BETWEEN ? AND ? ${cond} ORDER BY a.id DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 1000)],
  );
}

// ---------- Notifications ----------

// Crée les notifications à partir des alertes du tableau de bord et des commissions non encaissées depuis 30 jours.
// Chaque notification est créée une seule fois (clé unique). Retourne le nombre créé.
function syncNotifications(db, date = F.todayAlgiers()) {
  const dash = R.dashboard(db, SYSTEME, { date });
  let crees = 0;
  const ajouter = (type, niveau, message, lien, cle) => {
    crees += db.run('INSERT OR IGNORE INTO notifications (type, niveau, message, lien, cle) VALUES (?, ?, ?, ?, ?)', [type, niveau, message, lien, cle]).changes;
  };
  for (const a of dash.alertes) {
    const niveau = a.niveau === 'depassement' || a.niveau === 'alerte' ? 'alerte' : a.niveau === 'info' ? 'info' : 'avertissement';
    ajouter(a.type, niveau, a.message, a.lien, `${a.type}|${a.message}|${date}`);
  }
  const limite = R.decaler(date, -30);
  for (const c of db.all('SELECT id, reference, montant_calcule FROM commissions WHERE date_calcul <= ?', [limite])) {
    const encaisse = db.get('SELECT COALESCE(SUM(montant), 0) AS s FROM commission_collections WHERE commission_id = ?', [c.id]).s;
    if (encaisse < c.montant_calcule) {
      ajouter('commission_non_encaissee', 'avertissement',
        `Commission ${c.reference} : ${c.montant_calcule - encaisse} DA non encaissés depuis plus de 30 jours`,
        '/commissions', `commission|${c.id}`);
    }
  }
  return crees;
}

function listNotifications(db, actor, { lue = null } = {}) {
  if (actor.role !== 'ADMINISTRATEUR' && actor.role !== 'RESPONSABLE') fail('ACCES_REFUSE', 'Accès refusé pour cette action.');
  const cond = lue === null ? '' : 'WHERE lue = ?';
  return db.all(`SELECT * FROM notifications ${cond} ORDER BY id DESC LIMIT 200`, lue === null ? [] : [lue ? 1 : 0]);
}

function marquerLue(db, actor, id) {
  if (actor.role !== 'ADMINISTRATEUR' && actor.role !== 'RESPONSABLE') fail('ACCES_REFUSE', 'Accès refusé pour cette action.');
  const n = db.run('UPDATE notifications SET lue = 1 WHERE id = ?', [id]).changes;
  if (n === 0) fail('NOTIFICATION_INTROUVABLE', 'Notification introuvable.');
  return { id };
}

// ---------- Import CSV des commissions (prévisualisation, doublons, confirmation) ----------

const COLONNES_COMMISSION = ['reference', 'periode_debut', 'periode_fin', 'date_calcul', 'montant'];

function parseCsv(text) {
  const propre = String(text || '').replace(/^﻿/, '');
  const lignes = propre.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lignes.length === 0) return { entetes: [], lignes: [] };
  const sep = lignes[0].includes(';') ? ';' : ',';
  const analyser = (ligne) => {
    const out = [];
    let cur = '';
    let guill = false;
    for (let i = 0; i < ligne.length; i++) {
      const c = ligne[i];
      if (guill) {
        if (c === '"') {
          if (ligne[i + 1] === '"') { cur += '"'; i++; } else guill = false;
        } else cur += c;
      } else if (c === '"') guill = true;
      else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const entetes = analyser(lignes[0]).map((h) => h.toLowerCase());
  return {
    entetes,
    lignes: lignes.slice(1).map((l, i) => {
      const cellules = analyser(l);
      const o = { _ligne: i + 2 };
      entetes.forEach((h, j) => { o[h] = cellules[j] ?? ''; });
      return o;
    }),
  };
}

function analyserCommissions(db, actor, text) {
  F.requirePermission(actor, 'commission');
  const { entetes, lignes } = parseCsv(text);
  const manquantes = COLONNES_COMMISSION.filter((c) => !entetes.includes(c));
  if (manquantes.length) fail('COLONNES_MANQUANTES', `Colonnes manquantes : ${manquantes.join(', ')}.`);
  const existantes = new Set(db.all('SELECT reference FROM commissions').map((r) => r.reference));
  const vus = new Set();
  const resultats = lignes.map((l) => {
    const ref = (l.reference || '').trim();
    const montantBrut = String(l.montant || '').replace(/[\s ]/g, '');
    const montant = /^\d+$/.test(montantBrut) ? Number(montantBrut) : NaN;
    let message = null;
    let statut = 'pret';
    if (!ref) { statut = 'erreur'; message = 'Référence manquante'; }
    else if (!F.isValidDate(l.periode_debut) || !F.isValidDate(l.periode_fin) || !F.isValidDate(l.date_calcul)) { statut = 'erreur'; message = 'Dates invalides (AAAA-MM-JJ)'; }
    else if (!(montant > 0)) { statut = 'erreur'; message = 'Montant invalide (entier positif)'; }
    else if (l.periode_debut > l.periode_fin) { statut = 'erreur'; message = 'Période inversée'; }
    else if (existantes.has(ref)) { statut = 'doublon_base'; message = 'Référence déjà enregistrée'; }
    else if (vus.has(ref)) { statut = 'doublon_fichier'; message = 'Référence répétée dans le fichier'; }
    if (ref) vus.add(ref);
    return { ligne: l._ligne, reference: ref, periodeDebut: l.periode_debut, periodeFin: l.periode_fin, dateCalcul: l.date_calcul, montant: Number.isNaN(montant) ? null : montant, description: l.description || null, statut, message };
  });
  const compte = (s) => resultats.filter((r) => r.statut === s).length;
  return {
    lignes: resultats,
    pretes: compte('pret'),
    doublons: compte('doublon_base') + compte('doublon_fichier'),
    erreurs: compte('erreur'),
  };
}

// Import réel : n'importe que les lignes « prêtes ». Atomique : tout ou rien.
function importerCommissions(db, actor, text) {
  const analyse = analyserCommissions(db, actor, text);
  const aImporter = analyse.lignes.filter((l) => l.statut === 'pret');
  db.transaction((tx) => {
    for (const l of aImporter) {
      const id = tx.run(
        `INSERT INTO commissions (reference, periode_debut, periode_fin, date_calcul, montant_calcule, description, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [l.reference, l.periodeDebut, l.periodeFin, l.dateCalcul, l.montant, l.description, actor.userId],
      ).lastId;
      F.audit(tx, actor, 'import_commission', 'commissions', id, null, { reference: l.reference, montant: l.montant });
    }
  });
  return { importees: aImporter.length, doublonsIgnores: analyse.doublons, erreursIgnorees: analyse.erreurs };
}

// ---------- Exports et rapport de clôture ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV compatible Excel (BOM UTF-8, séparateur point-virgule).
function exporterCsv(db, actor, { from, to, registerId = null }) {
  const { lignes } = listTransactions(db, actor, { from, to, registerId, toutes: true });
  const entetes = ['Date', 'Caisse', 'Nature', 'Sens', 'Catégorie', 'Montant (DA)', 'Affecte la caisse', 'Mode', 'Référence', 'N° facture', 'Description', 'Utilisateur'];
  const corps = lignes.map((t) => [
    t.date.split('-').reverse().join('/'), t.caisse, t.nature, t.sens === 'entree' ? 'Entrée' : 'Sortie', t.categorie,
    t.montant, t.affecte_caisse ? 'Oui' : 'Non', t.mode_paiement, t.reference, t.numero_facture, t.description, t.utilisateur,
  ].map(csvCell).join(';'));
  return '﻿' + [entetes.join(';'), ...corps].join('\r\n');
}

const echap = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rapport de clôture imprimable (ouvrir dans le navigateur puis « Imprimer » > « Enregistrer en PDF »).
function rapportClotureHtml(db, actor, { registerId, date }) {
  F.requirePermission(actor, 'lire', registerId);
  const c = db.get('SELECT c.*, r.nom AS caisse FROM daily_closings c JOIN cash_registers r ON r.id = c.register_id WHERE c.register_id = ? AND c.date = ?', [registerId, date]);
  if (!c) fail('CLOTURE_INTROUVABLE', 'Aucune clôture pour cette caisse et cette date.');
  const { lignes } = listTransactions(db, actor, { registerId, from: date, to: date, toutes: true });
  const f = (n) => `${Number(n).toLocaleString('fr-FR')} DA`;
  const ligneOps = lignes.map((t) => `<tr><td>${echap(t.nature)}</td><td>${echap(t.categorie)}</td><td>${echap(t.description)}</td><td>${t.sens === 'entree' ? '+' : '−'}${f(t.montant)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Clôture ${echap(c.caisse)} ${echap(date)}</title>
<style>body{font-family:Arial,sans-serif;color:#263238;margin:32px}h1{color:#1553A4;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.ecart{font-weight:bold;color:${c.ecart === 0 ? '#263238' : '#b00020'}}
.sig{display:flex;gap:48px;margin-top:48px}.sig div{flex:1;border-top:1px solid #263238;padding-top:6px}</style></head><body>
<h1>MT Delivery — Rapport de clôture</h1>
<p><strong>Caisse :</strong> ${echap(c.caisse)} · <strong>Date :</strong> ${echap(date.split('-').reverse().join('/'))} · <strong>Statut :</strong> ${echap(c.statut)}</p>
<table><tr><th>Solde d'ouverture</th><td>${f(c.solde_ouverture)}</td></tr>
<tr><th>Entrées</th><td>${f(c.entrees)}</td></tr><tr><th>Dépenses</th><td>${f(c.sorties)}</td></tr>
<tr><th>Transferts reçus</th><td>${f(c.transferts_recus)}</td></tr><tr><th>Transferts envoyés</th><td>${f(c.transferts_envoyes)}</td></tr>
<tr><th>Solde théorique</th><td>${f(c.solde_theorique)}</td></tr><tr><th>Solde réel compté</th><td>${f(c.solde_reel)}</td></tr>
<tr><th>Écart</th><td class="ecart">${c.ecart > 0 ? '+' : ''}${f(c.ecart)}</td></tr>
<tr><th>Explication</th><td>${echap(c.explication || '—')}</td></tr></table>
<h3>Opérations du jour</h3><table><tr><th>Nature</th><th>Catégorie</th><th>Description</th><th>Montant</th></tr>${ligneOps || '<tr><td colspan="4">Aucune opération</td></tr>'}</table>
<div class="sig"><div>Caissier</div><div>Responsable</div></div></body></html>`;
}

module.exports = {
  SYSTEME,
  createUser,
  updateUser,
  listUsers,
  createRegister,
  updateRegister,
  setRegisterUsers,
  listRegisters,
  registerDetail,
  listTransactions,
  budgetsList,
  recurringList,
  getSettings,
  updateSettings,
  listAudit,
  syncNotifications,
  listNotifications,
  marquerLue,
  parseCsv,
  analyserCommissions,
  importerCommissions,
  exporterCsv,
  rapportClotureHtml,
  entierPositif,
};
