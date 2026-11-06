'use strict';

// Interface MT Delivery — Gestion de caisse. Vanilla JS, aucune dépendance.
// Toutes les règles sont appliquées par le serveur ; l'interface ne fait que les présenter.

const CATEGORIES_REVENU = ['Commissions encaissées', 'Alimentation de caisse', 'Remboursements reçus', 'Apports financiers', 'Autres revenus'];
const CATEGORIES_DEPENSE = ['Papier', 'Fournitures de bureau', 'Consommables', 'Carburant', 'Transport', 'Maintenance', 'Informatique',
  'Internet', 'Téléphone', 'Loyer', 'Administration', 'Personnel', 'Emballage', 'Logistique', 'Divers'];
const MODES = [['especes', 'Espèces'], ['cheque', 'Chèque'], ['virement', 'Virement'], ['carte', 'Carte'], ['autre', 'Autre']];
const ROLES = [['ADMINISTRATEUR', 'Administrateur'], ['RESPONSABLE', 'Responsable'], ['CAISSIER', 'Caissier'], ['CONSULTATION', 'Consultation']];
const FREQUENCES = [['quotidienne', 'Quotidienne'], ['hebdomadaire', 'Hebdomadaire'], ['mensuelle', 'Mensuelle'], ['annuelle', 'Annuelle']];
const NATURES = [['', 'Toutes'], ['revenu', 'Revenus'], ['depense', 'Dépenses'], ['transfert', 'Transferts'], ['commission', 'Commissions'], ['correction', 'Corrections']];
const ACTIONS_JOURNAL = ['creation_operation', 'transfert', 'correction', 'cloture', 'reouverture', 'encaissement_commission', 'creation_commission',
  'import_commission', 'creation_utilisateur', 'modification_utilisateur', 'modification_caisse', 'creation_caisse', 'budget', 'creation_tiers',
  'creation_recurrente', 'generation_echeances', 'echeance_ignoree', 'modification_parametres', 'affectation_utilisateurs_caisse'];

const ETAT = { user: null, ongletOps: 'entrees', filtresOps: null, filtresClotures: null };

const $ = (s, r = document) => r.querySelector(s);
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const da = (n) => `${Number(n || 0).toLocaleString('fr-FR')} DA`;
const dateFr = (d) => (d ? String(d).split('-').reverse().join('/') : '');
const aujourdhui = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const moisCourant = () => aujourdhui().slice(0, 7);
const debutMois = () => `${moisCourant()}-01`;
const estAdmin = () => ETAT.user?.role === 'ADMINISTRATEUR';
const peutGerer = () => ['ADMINISTRATEUR', 'RESPONSABLE'].includes(ETAT.user?.role);
const peutOperer = () => !!ETAT.user && ETAT.user.role !== 'CONSULTATION';
const options = (liste, valeur = '') => liste.map(([v, l]) => `<option value="${h(v)}" ${String(v) === String(valeur) ? 'selected' : ''}>${h(l)}</option>`).join('');
const simples = (liste) => liste.map((v) => [v, v]);
const libelleNiveau = (n) => ({ alerte: 'Alerte', depassement: 'Dépassement', atteint: 'Atteint', avertissement: 'Attention', info: 'Info', ok: 'OK' }[n] || n);

function qs(obj) {
  const p = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return p.length ? `?${p.join('&')}` : '';
}

function erreurHttp(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function api(method, chemin, corps) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (corps !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(corps); }
  const res = await fetch(`/api${chemin}`, opts);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw erreurHttp(res.status, 'Erreur serveur');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw erreurHttp(res.status, data.error?.message || 'Erreur', data.error?.code);
  return data;
}

function notifier(message, type = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', 'status');
  t.textContent = message;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

// Lit les champs d'un formulaire : nombres (data-num), vides -> null (data-null), cases multiples (data-multi).
function lireForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox' && el.dataset.multi !== undefined) {
      out[el.name] = out[el.name] || [];
      if (el.checked) out[el.name].push(Number(el.value));
      continue;
    }
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    let v = el.value;
    if (el.dataset.num !== undefined) v = v === '' ? null : Number(v);
    else if (el.dataset.null !== undefined && v === '') v = null;
    out[el.name] = v;
  }
  return out;
}

function champ(c) {
  const id = `f-${c.nom}`;
  const attrs = `name="${c.nom}" id="${id}" ${c.requis ? 'required' : ''} ${c.num ? 'data-num inputmode="decimal"' : ''} ${c.optionnel ? 'data-null' : ''} ${c.desactive ? 'disabled' : ''}`;
  let input;
  if (c.options) {
    input = `<select ${attrs}>${c.vide !== false ? `<option value="" ${c.valeur ? '' : 'selected'}>${c.videLibelle || '—'}</option>` : ''}${options(c.options, c.valeur)}</select>`;
  } else if (c.zone) {
    input = `<textarea ${attrs}>${h(c.valeur)}</textarea>`;
  } else {
    input = `<input type="${c.type || 'text'}" ${attrs} value="${h(c.valeur ?? '')}" ${c.min !== undefined ? `min="${c.min}"` : ''} ${c.pas ? `step="${c.pas}"` : ''} ${c.placeholder ? `placeholder="${h(c.placeholder)}"` : ''} autocomplete="off">`;
  }
  return `<div class="champ"><label for="${id}">${h(c.libelle)}${c.requis ? ' *' : ''}</label>${input}${c.aide ? `<small>${h(c.aide)}</small>` : ''}</div>`;
}

function modal(titre, contenu, onValider, libelleBouton = 'Enregistrer') {
  const fond = document.createElement('div');
  fond.className = 'modal-fond';
  fond.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${h(titre)}">
    <header><h2>${h(titre)}</h2><button type="button" class="btn-discret" data-fermer aria-label="Fermer">✕</button></header>
    <form novalidate>${contenu}<p class="erreur" data-erreur role="alert"></p>
    <div class="actions" style="justify-content:flex-end"><button type="button" class="btn-secondaire" data-fermer>Annuler</button>
    <button class="btn" type="submit">${h(libelleBouton)}</button></div></form></div>`;
  document.body.append(fond);
  const fermer = () => fond.remove();
  fond.querySelectorAll('[data-fermer]').forEach((b) => { b.onclick = fermer; });
  const form = fond.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const bouton = form.querySelector('button[type="submit"]');
    bouton.disabled = true;
    try {
      await onValider(lireForm(form), form, fermer);
    } catch (err) {
      fond.querySelector('[data-erreur]').textContent = err.message;
      bouton.disabled = false;
    }
  };
  const premier = form.querySelector('input,select,textarea');
  if (premier) premier.focus();
  return { fermer, form };
}

async function caisses() {
  return api('GET', '/caisses');
}

function optionsCaisses(liste, valeur = '') {
  return liste.map((c) => [c.id, `${c.nom} (${c.code})`]).map(([v, l]) => [v, l]);
}

// ---------- Graphiques (SVG, sans bibliothèque) ----------

function graphiqueBarres(points, cleLibelle, a, b) {
  if (!points.length) return '<p class="vide">Aucune donnée sur la période.</p>';
  const W = 640; const H = 220; const P = 28;
  const max = Math.max(1, ...points.flatMap((p) => [p[a], p[b]]));
  const largeur = (W - 2 * P) / points.length;
  const barres = points.map((p, i) => {
    const x = P + i * largeur;
    const ha = (p[a] / max) * (H - 2 * P);
    const hb = (p[b] / max) * (H - 2 * P);
    return `<rect x="${(x + 2).toFixed(1)}" y="${(H - P - ha).toFixed(1)}" width="${Math.max(largeur / 2 - 3, 1).toFixed(1)}" height="${ha.toFixed(1)}" fill="var(--bleu)"><title>${h(p[cleLibelle])} · revenus ${da(p[a])}</title></rect>
      <rect x="${(x + largeur / 2).toFixed(1)}" y="${(H - P - hb).toFixed(1)}" width="${Math.max(largeur / 2 - 3, 1).toFixed(1)}" height="${hb.toFixed(1)}" fill="var(--jaune)"><title>${h(p[cleLibelle])} · dépenses ${da(p[b])}</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Revenus et dépenses par période">${barres}
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--texte-doux)" /></svg>
    <div class="legende"><span class="pastille bleu"></span> Revenus <span class="pastille jaune"></span> Dépenses</div>`;
}

// ---------- Tableaux génériques ----------

function tableauOperations(lignes, { actions = false } = {}) {
  if (!lignes.length) return '<p class="vide">Aucune opération.</p>';
  return `<div class="panneau" style="padding:0"><table><thead><tr><th>Date</th><th>Caisse</th><th>Nature</th><th>Catégorie</th>
    <th>Description</th><th>Utilisateur</th><th class="num">Montant</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
    ${lignes.map((t) => `<tr>
      <td>${dateFr(t.date)}</td><td>${h(t.caisse)}</td>
      <td><span class="badge ${h(t.nature)}">${h(libelleNature(t.nature))}</span>${t.corrige_id ? ' <span class="badge correction">corrige</span>' : ''}</td>
      <td>${h(t.categorie || '')}${t.numero_facture ? `<br><small>Facture ${h(t.numero_facture)}</small>` : ''}</td>
      <td>${h(t.description || '')}${t.reference ? `<br><small>Réf. ${h(t.reference)}</small>` : ''}${t.affecte_caisse ? '' : '<br><small>Hors caisse (non espèces)</small>'}</td>
      <td>${h(t.utilisateur || '')}</td>
      <td class="num ${t.sens === 'entree' ? 'positif' : 'negatif'}">${t.sens === 'entree' ? '+' : '−'}${da(t.montant)}</td>
      ${actions ? `<td>${peutGerer() && t.nature !== 'transfert' && t.nature !== 'commission' && t.nature !== 'correction' && !t.corrige_id
    ? `<button class="btn-petit" data-action="corriger" data-id="${t.id}" data-desc="${h(t.description || t.categorie || '')}">Corriger</button>` : ''}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}

function libelleNature(n) {
  return { revenu: 'Revenu', depense: 'Dépense', transfert: 'Transfert', commission: 'Commission', correction: 'Correction' }[n] || n;
}

function tableau(colonnes, lignes, vide = 'Aucune donnée.') {
  if (!lignes.length) return `<p class="vide">${h(vide)}</p>`;
  return `<div class="panneau" style="padding:0"><table><thead><tr>${colonnes.map((c) => `<th class="${c.num ? 'num' : ''}">${h(c.libelle)}</th>`).join('')}</tr></thead>
    <tbody>${lignes.map((l) => `<tr ${l._attrs || ''}>${colonnes.map((c) => `<td class="${c.num ? 'num' : ''}">${c.rendu ? c.rendu(l) : h(l[c.cle])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- Tableau de bord ----------

async function pageTableauDeBord() {
  const [d, serie, cats] = await Promise.all([
    api('GET', `/tableau-de-bord?date=${aujourdhui()}`),
    api('GET', `/rapports/periodes${qs({ from: debutMois(), to: aujourdhui(), granularite: 'jour' })}`),
    api('GET', `/rapports/categories${qs({ from: debutMois(), to: aujourdhui() })}`),
  ]);
  const alertes = d.alertes.length
    ? `<ul class="alertes">${d.alertes.map((a) => `<li class="${h(a.niveau)}"><span class="badge ${h(a.niveau)}">${h(libelleNiveau(a.niveau))}</span>
        <span style="flex:1">${h(a.message)}</span><a class="btn-petit" href="#${h(a.lien)}">Ouvrir</a></li>`).join('')}</ul>`
    : '<p class="vide">Aucune alerte financière.</p>';
  const cartes = [
    ['Solde global', da(d.soldeGlobal), 'accent'], ['Entrées du jour', da(d.entreesJour)], ['Dépenses du jour', da(d.depensesJour)],
    ['Entrées du mois', da(d.entreesMois)], ['Dépenses du mois', da(d.depensesMois)], ['Opérations du jour', d.nbOperationsJour],
  ];
  const com = d.commissions ? `<div class="cartes">
    <div class="carte"><small>Commissions calculées</small><div class="valeur">${da(d.commissions.calculees)}</div></div>
    <div class="carte"><small>Commissions encaissées</small><div class="valeur">${da(d.commissions.encaissees)}</div></div>
    <div class="carte"><small>Restant à encaisser</small><div class="valeur">${da(d.commissions.restant)}</div></div></div>` : '';
  const html = `<h2>Tableau de bord — ${dateFr(d.date)}</h2>
    <div class="cartes">${cartes.map(([t, v, cls]) => `<div class="carte ${cls || ''}"><small>${h(t)}</small><div class="valeur">${v}</div></div>`).join('')}</div>
    ${com}
    <div class="grille-2">
      <section class="panneau"><h3>Alertes financières</h3>${alertes}</section>
      <section class="panneau"><h3>Caisses</h3>${tableau([
    { libelle: 'Caisse', cle: 'nom' },
    { libelle: 'Solde', num: true, rendu: (c) => `<span class="${c.soldeFaible ? 'negatif' : ''}">${da(c.solde)}</span>` },
    { libelle: 'Seuil', num: true, rendu: (c) => da(c.seuilAlerte) },
  ], d.caisses)}</section>
    </div>
    <section class="panneau"><h3>Revenus et dépenses — mois en cours</h3>${graphiqueBarres(serie, 'periode', 'revenus', 'depenses')}</section>
    <section class="panneau"><h3>Dépenses par catégorie — mois en cours</h3>${tableau([
    { libelle: 'Catégorie', cle: 'categorie' },
    { libelle: 'Opérations', cle: 'nb', num: true },
    { libelle: 'Total', num: true, rendu: (c) => da(c.total) },
  ], cats, 'Aucune dépense ce mois-ci.')}</section>`;
  return { html, lier: null };
}

// ---------- Caisses ----------

async function pageCaisses() {
  const liste = await caisses();
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2>Caisses</h2>
    ${estAdmin() ? '<button class="btn" data-action="nouvelle-caisse">+ Nouvelle caisse</button>' : ''}</div>
    <div class="cartes">${liste.map((c) => `<a class="carte accent" href="#/caisses/${c.id}" style="text-decoration:none;color:inherit">
      <small>${h(c.code)} · ${c.statut === 'active' ? 'Active' : 'Inactive'}</small><div><strong>${h(c.nom)}</strong></div>
      <div class="valeur ${c.soldeActuel < c.seuil_alerte ? 'negatif' : ''}">${da(c.soldeActuel)}</div>
      <small>Seuil d'alerte : ${da(c.seuil_alerte)}</small></a>`).join('') || '<p class="vide">Aucune caisse accessible.</p>'}</div>`;
  const lier = (c) => {
    const b = c.querySelector('[data-action="nouvelle-caisse"]');
    if (b) b.onclick = () => modal('Nouvelle caisse', `
      <div class="grille-form">${champ({ nom: 'code', libelle: 'Code', requis: true, placeholder: 'PRINC' })}
      ${champ({ nom: 'nom', libelle: 'Nom', requis: true })}
      ${champ({ nom: 'soldeInitial', libelle: 'Solde initial (DA)', type: 'number', num: true, valeur: 0, min: 0 })}
      ${champ({ nom: 'dateOuverture', libelle: "Date d'ouverture", type: 'date', requis: true, valeur: aujourdhui() })}
      ${champ({ nom: 'seuilAlerte', libelle: "Seuil d'alerte (DA)", type: 'number', num: true, valeur: 0, min: 0 })}</div>
      ${champ({ nom: 'description', libelle: 'Description', optionnel: true })}`,
    async (v, form, fermer) => { await api('POST', '/caisses', v); fermer(); notifier('Caisse créée.'); rendre(); });
  };
  return { html, lier };
}

async function pageCaisseDetail(id) {
  const d = await api('GET', `/caisses/${id}`);
  const c = d.caisse;
  const t = d.totaux;
  const utilisateurs = estAdmin() ? await api('GET', '/utilisateurs') : [];
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px">
      <div><a href="#/caisses">← Caisses</a><h2 style="margin:4px 0 0">${h(c.nom)} <small>(${h(c.code)})</small></h2>
      <small>Ouverte le ${dateFr(c.date_ouverture)} · ${c.statut === 'active' ? 'Active' : 'Inactive'}</small></div>
      ${estAdmin() ? `<div class="actions"><button class="btn-secondaire" data-action="modifier">Modifier</button>
      <button class="btn-secondaire" data-action="affecter">Utilisateurs</button></div>` : ''}</div>
    <div class="cartes">
      <div class="carte accent"><small>Solde actuel</small><div class="valeur ${c.soldeActuel < c.seuil_alerte ? 'negatif' : ''}">${da(c.soldeActuel)}</div></div>
      <div class="carte"><small>Entrées</small><div class="valeur">${da(t.revenus)}</div></div>
      <div class="carte"><small>Dépenses</small><div class="valeur">${da(t.depenses)}</div></div>
      <div class="carte"><small>Transferts reçus</small><div class="valeur">${da(d.transfertsRecus)}</div></div>
      <div class="carte"><small>Transferts envoyés</small><div class="valeur">${da(d.transfertsEnvoyes)}</div></div>
    </div>
    <div class="grille-2">
      <section class="panneau"><h3>Responsables et utilisateurs</h3>${tableau([
    { libelle: 'Nom', cle: 'nom' }, { libelle: 'Rôle', rendu: (u) => h(ROLES.find((r) => r[0] === u.role)?.[1] || u.role) },
  ], d.utilisateurs, 'Aucun utilisateur affecté.')}</section>
      <section class="panneau"><h3>Clôtures récentes</h3>${tableau([
    { libelle: 'Date', rendu: (k) => dateFr(k.date) },
    { libelle: 'Écart', num: true, rendu: (k) => `<span class="${k.ecart === 0 ? '' : 'negatif'}">${k.ecart > 0 ? '+' : ''}${da(k.ecart)}</span>` },
    { libelle: 'Statut', rendu: (k) => `<span class="badge ${k.statut === 'cloturee' ? 'ok' : 'avertissement'}">${h(k.statut)}</span>` },
  ], d.clotures, 'Aucune clôture.')}</section>
    </div>
    <h3>Historique des opérations</h3>
    <div class="barre-outils"><div class="champ"><label for="q-caisse">Recherche</label><input id="q-caisse" placeholder="Description, référence…"></div>
      <div class="champ"><label for="n-caisse">Nature</label><select id="n-caisse">${options(NATURES, '')}</select></div></div>
    <div id="historique-caisse">${tableauOperations(d.operations)}</div>`;
  const lier = (conteneur) => {
    const rechercher = async () => {
      const q = $('#q-caisse', conteneur).value;
      const nature = $('#n-caisse', conteneur).value;
      const res = await api('GET', `/operations${qs({ registerId: id, q, nature, limit: 100 })}`);
      $('#historique-caisse', conteneur).innerHTML = tableauOperations(res.lignes, { actions: true });
      liaisonsOperations(conteneur);
    };
    $('#q-caisse', conteneur).oninput = rechercher;
    $('#n-caisse', conteneur).onchange = rechercher;
    liaisonsOperations(conteneur);
    const modifier = conteneur.querySelector('[data-action="modifier"]');
    if (modifier) modifier.onclick = () => modal(`Modifier « ${c.nom} »`, `
      <div class="grille-form">${champ({ nom: 'nom', libelle: 'Nom', valeur: c.nom, requis: true })}
      ${champ({ nom: 'seuilAlerte', libelle: "Seuil d'alerte (DA)", type: 'number', num: true, valeur: c.seuil_alerte, min: 0 })}
      ${champ({ nom: 'statut', libelle: 'Statut', options: [['active', 'Active'], ['inactive', 'Inactive']], valeur: c.statut, vide: false })}
      ${champ({ nom: 'responsableId', libelle: 'Responsable', num: true, optionnel: true, options: utilisateurs.map((u) => [u.id, u.nom]), valeur: c.responsable_id })}
      ${champ({ nom: 'soldeInitial', libelle: 'Solde initial (DA)', type: 'number', num: true, valeur: c.solde_initial, min: 0, aide: 'Modifiable seulement tant que la caisse n\'a aucun mouvement.' })}</div>
      ${champ({ nom: 'description', libelle: 'Description', valeur: c.description || '', zone: true })}`,
    async (v, form, fermer) => { await api('PUT', `/caisses/${id}`, v); fermer(); notifier('Caisse mise à jour.'); rendre(); });
    const affecter = conteneur.querySelector('[data-action="affecter"]');
    if (affecter) affecter.onclick = () => modal(`Utilisateurs de « ${c.nom} »`, `
      ${utilisateurs.map((u) => `<div class="inline"><input type="checkbox" name="userIds" value="${u.id}" data-multi id="u-${u.id}" ${d.utilisateurs.some((x) => x.id === u.id) ? 'checked' : ''}>
        <label for="u-${u.id}">${h(u.nom)} <small>(${h(u.role)})</small></label></div>`).join('') || '<p class="muted">Aucun utilisateur.</p>'}`,
    async (v, form, fermer) => { await api('PUT', `/caisses/${id}/utilisateurs`, { userIds: v.userIds || [] }); fermer(); notifier('Affectations enregistrées.'); rendre(); });
  };
  return { html, lier };
}

function liaisonsOperations(conteneur) {
  conteneur.querySelectorAll('[data-action="corriger"]').forEach((b) => {
    b.onclick = () => modal('Corriger une opération', `
      <p class="muted">${h(b.dataset.desc)}</p>
      <p>Une contre-écriture annule l'opération d'origine. L'original reste dans le journal.</p>
      ${champ({ nom: 'motif', libelle: 'Motif de la correction', requis: true, zone: true })}
      ${champ({ nom: 'date', libelle: 'Date de la correction', type: 'date', valeur: aujourdhui(), requis: true, aide: 'Doit être une journée non clôturée.' })}`,
    async (v, form, fermer) => {
      await api('POST', `/operations/${b.dataset.id}/corriger`, { motif: v.motif, date: v.date });
      fermer(); notifier('Correction enregistrée.'); rendre();
    }, 'Corriger');
  });
}

// ---------- Entrées et dépenses ----------

async function pageOperations() {
  const liste = await caisses();
  const onglet = ETAT.ongletOps;
  const f = ETAT.filtresOps || { from: debutMois(), to: aujourdhui(), registerId: '', nature: '', q: '' };
  ETAT.filtresOps = f;
  const res = await api('GET', `/operations${qs({ from: f.from, to: f.to, registerId: f.registerId, nature: f.nature, q: f.q, limit: 200 })}`);
  const formRevenu = `<form data-form="revenu" class="panneau"><h2>Nouvelle entrée</h2><div class="grille-form">
    ${champ({ nom: 'date', libelle: 'Date', type: 'date', valeur: aujourdhui(), requis: true })}
    ${champ({ nom: 'registerId', libelle: 'Caisse', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
    ${champ({ nom: 'categorie', libelle: 'Catégorie', requis: true, options: simples(CATEGORIES_REVENU), vide: false })}
    ${champ({ nom: 'montant', libelle: 'Montant (DA)', type: 'number', num: true, requis: true, min: 1 })}
    ${champ({ nom: 'reference', libelle: 'Référence', optionnel: true })}
    ${champ({ nom: 'description', libelle: 'Description', optionnel: true })}</div>
    <div class="actions"><button class="btn" type="submit">Enregistrer l'entrée</button></div></form>`;
  const formDepense = `<form data-form="depense" class="panneau"><h2>Nouvelle dépense</h2><div class="grille-form">
    ${champ({ nom: 'date', libelle: 'Date', type: 'date', valeur: aujourdhui(), requis: true })}
    ${champ({ nom: 'registerId', libelle: 'Caisse', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
    ${champ({ nom: 'categorie', libelle: 'Catégorie', requis: true, options: simples(CATEGORIES_DEPENSE), vide: false })}
    ${champ({ nom: 'montant', libelle: 'Montant (DA)', type: 'number', num: true, requis: true, min: 1 })}
    ${champ({ nom: 'modePaiement', libelle: 'Mode de paiement', options: MODES, valeur: 'especes', vide: false, aide: 'Hors espèces : la dépense ne sort pas de la caisse physique.' })}
    ${champ({ nom: 'fournisseurId', libelle: 'Fournisseur', num: true, optionnel: true, options: [], vide: true })}
    ${champ({ nom: 'beneficiaireId', libelle: 'Bénéficiaire', num: true, optionnel: true, options: [], vide: true })}
    ${champ({ nom: 'numeroFacture', libelle: 'N° de facture', optionnel: true })}
    ${champ({ nom: 'reference', libelle: 'Référence', optionnel: true })}
    ${champ({ nom: 'description', libelle: 'Description', optionnel: true })}</div>
    <div class="actions"><button class="btn" type="submit">Enregistrer la dépense</button></div></form>`;
  const onglets = [['entrees', 'Entrées'], ['depenses', 'Dépenses'], ['liste', 'Liste complète']];
  const html = `<h2>Entrées et dépenses</h2>
    <div class="onglets" role="tablist">${onglets.map(([id, l]) => `<button type="button" role="tab" data-onglet="${id}" class="${onglet === id ? 'actif' : ''}">${l}</button>`).join('')}</div>
    ${peutOperer() && onglet === 'entrees' ? formRevenu : ''}
    ${peutOperer() && onglet === 'depenses' ? formDepense : ''}
    <form data-form="filtre" class="barre-outils">
      <div class="champ"><label for="f-from">Du</label><input type="date" id="f-from" name="from" value="${f.from}"></div>
      <div class="champ"><label for="f-to">Au</label><input type="date" id="f-to" name="to" value="${f.to}"></div>
      <div class="champ"><label for="f-caisse">Caisse</label><select id="f-caisse" name="registerId"><option value="">Toutes</option>${options(optionsCaisses(liste), f.registerId)}</select></div>
      <div class="champ"><label for="f-nature">Nature</label><select id="f-nature" name="nature">${options(NATURES, f.nature)}</select></div>
      <div class="champ"><label for="f-q">Recherche</label><input id="f-q" name="q" value="${h(f.q)}" placeholder="Description, référence, catégorie"></div>
      <div class="actions"><button class="btn-secondaire" type="submit">Filtrer</button>
      <button class="btn-secondaire" type="button" data-action="export">Exporter (CSV)</button></div>
    </form>
    <p class="muted">${res.total} opération(s) · ${res.lignes.length} affichée(s)</p>
    ${tableauOperations(res.lignes, { actions: true })}`;
  const lier = (c) => {
    c.querySelectorAll('[data-onglet]').forEach((b) => { b.onclick = () => { ETAT.ongletOps = b.dataset.onglet; rendre(); }; });
    const fournisseurs = c.querySelector('[data-form="depense"]');
    if (fournisseurs) {
      Promise.all([api('GET', '/tiers/fournisseurs'), api('GET', '/tiers/beneficiaires')]).then(([fo, be]) => {
        const sf = fournisseurs.querySelector('[name="fournisseurId"]');
        const sb = fournisseurs.querySelector('[name="beneficiaireId"]');
        sf.innerHTML = `<option value="">—</option>${options(fo.map((x) => [x.id, x.nom]))}`;
        sb.innerHTML = `<option value="">—</option>${options(be.map((x) => [x.id, x.nom]))}`;
      });
    }
    c.querySelectorAll('[data-form="revenu"], [data-form="depense"]').forEach((form) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const v = lireForm(form);
        const nature = form.dataset.form === 'revenu' ? 'revenu' : 'depense';
        const bouton = form.querySelector('button[type="submit"]');
        bouton.disabled = true;
        try {
          const r = await api('POST', '/operations', { ...v, nature, reference: v.reference || null });
          notifier(`Opération enregistrée. Solde de la caisse : ${da(r.soldeApres)}`);
          rendre();
        } catch (err) {
          notifier(err.message, 'ko');
          bouton.disabled = false;
        }
      };
    });
    const filtre = c.querySelector('[data-form="filtre"]');
    filtre.onsubmit = (e) => { e.preventDefault(); const v = lireForm(filtre); ETAT.filtresOps = { ...f, ...v, registerId: v.registerId || '' }; rendre(); };
    c.querySelector('[data-action="export"]').onclick = () => {
      const v = lireForm(filtre);
      window.location.href = `/api/export.csv${qs({ from: v.from, to: v.to, registerId: v.registerId })}`;
    };
    liaisonsOperations(c);
  };
  return { html, lier };
}

// ---------- Transferts ----------

async function pageTransferts() {
  const liste = await caisses();
  const transferts = await api('GET', `/operations${qs({ nature: 'transfert', from: debutMois(), to: aujourdhui(), limit: 200 })}`);
  const html = `<h2>Transferts entre caisses</h2>
    <form data-form="transfert" class="panneau"><div class="grille-form">
      ${champ({ nom: 'sourceId', libelle: 'Caisse source', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
      ${champ({ nom: 'destinationId', libelle: 'Caisse destinataire', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
      ${champ({ nom: 'date', libelle: 'Date', type: 'date', valeur: aujourdhui(), requis: true })}
      ${champ({ nom: 'montant', libelle: 'Montant (DA)', type: 'number', num: true, requis: true, min: 1 })}
      ${champ({ nom: 'reference', libelle: 'Référence', optionnel: true, aide: 'Vide : générée automatiquement.' })}
      ${champ({ nom: 'description', libelle: 'Description', optionnel: true })}</div>
      <div class="actions"><button class="btn" type="submit">Enregistrer le transfert</button></div></form>
    <h3>Transferts du mois (mouvements de chaque caisse)</h3>
    ${tableauOperations(transferts.lignes)}`;
  const lier = (c) => {
    const form = c.querySelector('[data-form="transfert"]');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = lireForm(form);
      try {
        const r = await api('POST', '/transferts', { ...v, reference: v.reference || null });
        notifier(`Transfert ${r.reference} enregistré. Soldes : ${da(r.soldeSource)} / ${da(r.soldeDestination)}`);
        rendre();
      } catch (err) { notifier(err.message, 'ko'); }
    };
  };
  return { html, lier };
}

// ---------- Commissions ----------

async function pageCommissions() {
  const [liste, lignes] = await Promise.all([caisses(), api('GET', '/commissions')]);
  const totaux = lignes.reduce((a, c) => ({ calc: a.calc + c.montant_calcule, enc: a.enc + c.encaisse, reste: a.reste + c.reste }), { calc: 0, enc: 0, reste: 0 });
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2>Commissions de livraison</h2>
    <div class="actions"><button class="btn" data-action="nouvelle">+ Nouvelle commission</button>
    <button class="btn-secondaire" data-action="import">Importer (CSV)</button></div></div>
    <div class="cartes">
      <div class="carte"><small>Calculées</small><div class="valeur">${da(totaux.calc)}</div></div>
      <div class="carte"><small>Encaissées</small><div class="valeur">${da(totaux.enc)}</div></div>
      <div class="carte accent"><small>Restant à encaisser</small><div class="valeur">${da(totaux.reste)}</div></div></div>
    ${tableau([
    { libelle: 'Référence', cle: 'reference' },
    { libelle: 'Période', rendu: (c) => `${dateFr(c.periode_debut)} → ${dateFr(c.periode_fin)}` },
    { libelle: 'Calculée', num: true, rendu: (c) => da(c.montant_calcule) },
    { libelle: 'Encaissée', num: true, rendu: (c) => da(c.encaisse) },
    { libelle: 'Reste', num: true, rendu: (c) => `<span class="${c.reste > 0 ? 'negatif' : 'positif'}">${da(c.reste)}</span>` },
    { libelle: '', rendu: (c) => c.reste > 0 ? `<button class="btn-petit" data-action="encaisser" data-id="${c.id}" data-reste="${c.reste}" data-ref="${h(c.reference)}">Encaisser</button>` : '<span class="badge ok">Soldée</span>' },
  ], lignes, 'Aucune commission.')}
    <section id="zone-import"></section>`;
  const lier = (c) => {
    c.querySelector('[data-action="nouvelle"]').onclick = () => modal('Nouvelle commission', `
      <div class="grille-form">${champ({ nom: 'reference', libelle: 'Référence', requis: true })}
      ${champ({ nom: 'dateCalcul', libelle: 'Date de calcul', type: 'date', valeur: aujourdhui(), requis: true })}
      ${champ({ nom: 'periodeDebut', libelle: 'Début de période', type: 'date', requis: true, valeur: debutMois() })}
      ${champ({ nom: 'periodeFin', libelle: 'Fin de période', type: 'date', requis: true, valeur: aujourdhui() })}
      ${champ({ nom: 'montant', libelle: 'Montant calculé (DA)', type: 'number', num: true, requis: true, min: 1 })}</div>
      ${champ({ nom: 'description', libelle: 'Description', optionnel: true })}`,
    async (v, form, fermer) => { await api('POST', '/commissions', v); fermer(); notifier('Commission enregistrée.'); rendre(); });
    c.querySelectorAll('[data-action="encaisser"]').forEach((b) => {
      b.onclick = () => modal(`Encaisser ${b.dataset.ref}`, `
        <p class="muted">Reste à encaisser : <strong>${da(b.dataset.reste)}</strong>. Seul le montant encaissé alimente la caisse.</p>
        ${champ({ nom: 'registerId', libelle: 'Caisse de réception', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
        ${champ({ nom: 'montant', libelle: 'Montant encaissé (DA)', type: 'number', num: true, requis: true, min: 1 })}
        ${champ({ nom: 'date', libelle: 'Date', type: 'date', valeur: aujourdhui(), requis: true })}
        ${champ({ nom: 'reference', libelle: 'Référence du versement', optionnel: true })}`,
      async (v, form, fermer) => { await api('POST', `/commissions/${b.dataset.id}/encaissements`, { ...v, reference: v.reference || null }); fermer(); notifier('Encaissement enregistré.'); rendre(); },
      'Encaisser');
    });
    c.querySelector('[data-action="import"]').onclick = () => {
      $('#zone-import', c).innerHTML = `<section class="panneau"><h2>Import CSV des commissions</h2>
        <p class="muted">Colonnes : reference ; periode_debut ; periode_fin ; date_calcul ; montant ; description (séparateur « ; » ou « , »). Dates AAAA-MM-JJ.</p>
        <div class="champ"><label for="fichier-csv">Fichier CSV</label><input type="file" id="fichier-csv" accept=".csv,text/csv"></div>
        <div class="champ"><label for="texte-csv">ou collez le contenu</label><textarea id="texte-csv"></textarea></div>
        <div class="actions"><button class="btn-secondaire" data-action="apercu">Prévisualiser</button></div>
        <div id="apercu-csv"></div></section>`;
      const zone = $('#zone-import', c);
      $('#fichier-csv', zone).onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const lecteur = new FileReader();
        lecteur.onload = () => { $('#texte-csv', zone).value = lecteur.result; };
        lecteur.readAsText(f, 'utf-8');
      };
      zone.querySelector('[data-action="apercu"]').onclick = async () => {
        const csv = $('#texte-csv', zone).value;
        try {
          const a = await api('POST', '/commissions/import/apercu', { csv });
          $('#apercu-csv', zone).innerHTML = `<p><strong>${a.pretes}</strong> prête(s) · <strong>${a.doublons}</strong> doublon(s) ignoré(s) · <strong>${a.erreurs}</strong> erreur(s)</p>
            ${tableau([
    { libelle: 'Ligne', cle: 'ligne' }, { libelle: 'Référence', cle: 'reference' },
    { libelle: 'Montant', num: true, rendu: (l) => l.montant === null ? '—' : da(l.montant) },
    { libelle: 'Statut', rendu: (l) => `<span class="badge ${l.statut === 'pret' ? 'ok' : l.statut === 'erreur' ? 'alerte' : 'avertissement'}">${h(l.message || 'Prête')}</span>` },
  ], a.lignes)}
            <div class="actions"><button class="btn" data-action="confirmer" ${a.pretes ? '' : 'disabled'}>Confirmer l'import de ${a.pretes} commission(s)</button></div>`;
          const bouton = $('#apercu-csv [data-action="confirmer"]', zone);
          if (bouton) bouton.onclick = async () => {
            const r = await api('POST', '/commissions/import', { csv });
            notifier(`${r.importees} commission(s) importée(s), ${r.doublonsIgnores} doublon(s) ignoré(s).`);
            rendre();
          };
        } catch (err) { notifier(err.message, 'ko'); }
      };
    };
  };
  return { html, lier };
}

// ---------- Clôtures ----------

async function pageClotures() {
  const liste = await caisses();
  const f = ETAT.filtresClotures || { registerId: '', from: debutMois(), to: aujourdhui() };
  ETAT.filtresClotures = f;
  const res = await api('GET', `/clotures${qs({ registerId: f.registerId, from: f.from, to: f.to })}`);
  const html = `<h2>Clôtures quotidiennes</h2>
    <form data-form="cloture" class="panneau"><h3>Clôturer une journée</h3><div class="grille-form">
      ${champ({ nom: 'registerId', libelle: 'Caisse', num: true, requis: true, options: optionsCaisses(liste), vide: false })}
      ${champ({ nom: 'date', libelle: 'Journée', type: 'date', valeur: aujourdhui(), requis: true })}
      ${champ({ nom: 'actual', libelle: 'Montant réellement compté (DA)', type: 'number', num: true, requis: true, min: 0 })}
      ${champ({ nom: 'explication', libelle: 'Explication (obligatoire en cas d\'écart)', optionnel: true, zone: true })}</div>
      <div class="actions"><button class="btn" type="submit">Clôturer la journée</button></div></form>
    <form data-form="filtre-cloture" class="barre-outils">
      <div class="champ"><label for="c-caisse">Caisse</label><select id="c-caisse" name="registerId"><option value="">Toutes</option>${options(optionsCaisses(liste), f.registerId)}</select></div>
      <div class="champ"><label for="c-from">Du</label><input type="date" id="c-from" name="from" value="${f.from}"></div>
      <div class="champ"><label for="c-to">Au</label><input type="date" id="c-to" name="to" value="${f.to}"></div>
      <div class="actions"><button class="btn-secondaire" type="submit">Filtrer</button></div></form>
    <p class="muted">Écarts : ${res.nbEcarts} journée(s) avec écart · total ${da(res.totalEcart)}</p>
    ${tableau([
    { libelle: 'Date', rendu: (k) => dateFr(k.date) },
    { libelle: 'Caisse', cle: 'caisse' },
    { libelle: 'Théorique', num: true, rendu: (k) => da(k.solde_theorique) },
    { libelle: 'Compté', num: true, rendu: (k) => da(k.solde_reel) },
    { libelle: 'Écart', num: true, rendu: (k) => `<span class="${k.ecart === 0 ? '' : 'negatif'}">${k.ecart > 0 ? '+' : ''}${da(k.ecart)}</span>` },
    { libelle: 'Statut', rendu: (k) => `<span class="badge ${k.statut === 'cloturee' ? 'ok' : 'avertissement'}">${k.statut === 'cloturee' ? 'Clôturée' : 'Réouverte'}</span>${k.explication ? `<br><small>${h(k.explication)}</small>` : ''}` },
    { libelle: '', rendu: (k) => `<div class="actions"><button class="btn-petit" data-action="rapport" data-caisse="${k.register_id}" data-date="${k.date}">Rapport PDF</button>
      ${estAdmin() && k.statut === 'cloturee' ? `<button class="btn-petit" data-action="rouvrir" data-caisse="${k.register_id}" data-date="${k.date}">Rouvrir</button>` : ''}</div>` },
  ], res.lignes, 'Aucune clôture sur la période.')}`;
  const lier = (c) => {
    const form = c.querySelector('[data-form="cloture"]');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = lireForm(form);
      try {
        const r = await api('POST', '/clotures', { ...v, explication: v.explication || null });
        notifier(`Journée clôturée. Écart : ${r.ecart > 0 ? '+' : ''}${da(r.ecart)}`);
        rendre();
      } catch (err) { notifier(err.message, 'ko'); }
    };
    const filtre = c.querySelector('[data-form="filtre-cloture"]');
    filtre.onsubmit = (e) => { e.preventDefault(); const v = lireForm(filtre); ETAT.filtresClotures = { registerId: v.registerId || '', from: v.from, to: v.to }; rendre(); };
    c.querySelectorAll('[data-action="rapport"]').forEach((b) => {
      b.onclick = () => window.open(`/api/clotures/rapport${qs({ registerId: b.dataset.caisse, date: b.dataset.date })}`, '_blank', 'noopener');
    });
    c.querySelectorAll('[data-action="rouvrir"]').forEach((b) => {
      b.onclick = () => modal('Réouvrir la journée', `
        <p>Cette action est tracée dans le journal d'activité. Le motif est obligatoire.</p>
        ${champ({ nom: 'motif', libelle: 'Motif de la réouverture', requis: true, zone: true })}`,
      async (v, form, fermer) => {
        await api('POST', '/clotures/reouverture', { registerId: Number(b.dataset.caisse), date: b.dataset.date, motif: v.motif });
        fermer(); notifier('Journée réouverte.'); rendre();
      }, 'Réouvrir');
    });
  };
  return { html, lier };
}

// ---------- Fournisseurs et bénéficiaires ----------

const LIBELLES_TIERS = { fournisseurs: { singulier: 'fournisseur', pluriel: 'Fournisseurs' }, beneficiaires: { singulier: 'bénéficiaire', pluriel: 'Bénéficiaires' } };

async function pageTiers(kind, selection = null) {
  const q = ETAT.recherche?.[kind] || '';
  const liste = await api('GET', `/tiers/${kind}${qs({ q })}`);
  const L = LIBELLES_TIERS[kind];
  let detail = '';
  if (selection) {
    const s = await api('GET', `/tiers/${kind}/${selection}`);
    const f = s.fiche;
    detail = `<section class="panneau"><div class="actions" style="justify-content:space-between"><h2>${h(f.nom)}</h2>
      ${peutGerer() ? '<button class="btn-secondaire" data-action="modifier-tiers">Modifier</button>' : ''}</div>
      <p class="muted">${h(f.telephone || '')} ${h(f.email || '')} ${h(f.adresse || '')} ${h(f.categorie || '')}</p>
      <div class="cartes"><div class="carte accent"><small>Total payé</small><div class="valeur">${da(s.totalPaye)}</div></div>
      <div class="carte"><small>Paiements</small><div class="valeur">${s.nombreDepenses}</div></div>
      <div class="carte"><small>Dernier paiement</small><div class="valeur">${dateFr(s.dernierPaiement) || '—'}</div></div></div>
      <h3>Factures associées</h3><p>${s.factures.length ? s.factures.map(h).join(', ') : '<span class="muted">Aucune facture renseignée.</span>'}</p>
      <h3>Historique des dépenses</h3>
      ${tableau([
    { libelle: 'Date', rendu: (x) => dateFr(x.date) }, { libelle: 'Catégorie', cle: 'categorie' },
    { libelle: 'Facture', rendu: (x) => h(x.numero_facture || '') }, { libelle: 'Description', cle: 'description' },
    { libelle: 'Montant', num: true, rendu: (x) => `${x.sens === 'entree' ? '+' : '−'}${da(x.montant)}` },
  ], s.historique, 'Aucune dépense.')}</section>`;
  }
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2>${L.pluriel}</h2>
      ${peutGerer() ? `<button class="btn" data-action="nouveau-tiers">+ Nouveau ${L.singulier}</button>` : ''}</div>
    <div class="barre-outils"><div class="champ"><label for="recherche-tiers">Rechercher</label>
      <input id="recherche-tiers" value="${h(q)}" placeholder="Nom"></div></div>
    <div class="grille-2">
      ${tableau([
    { libelle: 'Nom', rendu: (t) => `<a href="#/${kind}/${t.id}">${h(t.nom)}</a>` },
    { libelle: 'Téléphone', rendu: (t) => h(t.telephone || '') }, { libelle: 'Catégorie', rendu: (t) => h(t.categorie || '') },
  ], liste, `Aucun ${L.singulier}.`)}
      <div>${detail}</div></div>`;
  const lier = (c) => {
    const rech = $('#recherche-tiers', c);
    rech.oninput = () => { ETAT.recherche = { ...(ETAT.recherche || {}), [kind]: rech.value }; clearTimeout(rech._t); rech._t = setTimeout(rendre, 300); };
    const nouveau = c.querySelector('[data-action="nouveau-tiers"]');
    if (nouveau) nouveau.onclick = () => modal(`Nouveau ${L.singulier}`, formTiers(), async (v, form, fermer) => {
      const r = await api('POST', `/tiers/${kind}`, v); fermer(); notifier('Enregistré.'); location.hash = `#/${kind}/${r.id}`;
    });
    const modifier = c.querySelector('[data-action="modifier-tiers"]');
    if (modifier) modifier.onclick = async () => {
      const s = await api('GET', `/tiers/${kind}/${selection}`);
      modal(`Modifier ${s.fiche.nom}`, formTiers(s.fiche), async (v, form, fermer) => {
        await api('PUT', `/tiers/${kind}/${selection}`, v); fermer(); notifier('Modifié.'); rendre();
      });
    };
  };
  return { html, lier };
}

function formTiers(f = {}) {
  return `<div class="grille-form">${champ({ nom: 'nom', libelle: 'Nom', requis: true, valeur: f.nom || '' })}
    ${champ({ nom: 'telephone', libelle: 'Téléphone', optionnel: true, valeur: f.telephone || '' })}
    ${champ({ nom: 'email', libelle: 'E-mail', type: 'email', optionnel: true, valeur: f.email || '' })}
    ${champ({ nom: 'adresse', libelle: 'Adresse', optionnel: true, valeur: f.adresse || '' })}
    ${champ({ nom: 'categorie', libelle: 'Catégorie', optionnel: true, valeur: f.categorie || '' })}</div>
    ${champ({ nom: 'description', libelle: 'Description', optionnel: true, valeur: f.description || '', zone: true })}`;
}

// ---------- Budgets ----------

async function pageBudgets() {
  const liste = await caisses();
  const f = ETAT.filtresBudgets || { mois: moisCourant(), registerId: liste[0]?.id || '' };
  ETAT.filtresBudgets = f;
  const lignes = f.registerId ? await api('GET', `/budgets${qs({ mois: f.mois, registerId: f.registerId })}`) : [];
  const html = `<h2>Budgets mensuels</h2>
    <form data-form="budget-filtre" class="barre-outils">
      <div class="champ"><label for="b-mois">Mois</label><input type="month" id="b-mois" name="mois" value="${f.mois}"></div>
      <div class="champ"><label for="b-caisse">Caisse</label><select id="b-caisse" name="registerId">${options(optionsCaisses(liste), f.registerId)}</select></div>
      <div class="actions"><button class="btn-secondaire" type="submit">Afficher</button></div></form>
    ${peutGerer() ? `<form data-form="budget" class="panneau"><h3>Définir un budget</h3><div class="grille-form">
      ${champ({ nom: 'categorie', libelle: 'Catégorie', options: simples(CATEGORIES_DEPENSE), vide: false, requis: true })}
      ${champ({ nom: 'montant', libelle: 'Budget (DA)', type: 'number', num: true, requis: true, min: 1 })}</div>
      <div class="actions"><button class="btn" type="submit">Enregistrer le budget</button></div></form>` : ''}
    ${lignes.length ? `<div class="panneau" style="padding:0"><table><thead><tr><th>Catégorie</th><th class="num">Budget</th><th class="num">Dépensé</th>
      <th class="num">Restant</th><th style="min-width:160px">Consommé</th><th>Niveau</th></tr></thead><tbody>
      ${lignes.map((b) => `<tr><td>${h(b.categorie)}</td><td class="num">${da(b.initial)}</td><td class="num">${da(b.depense)}</td>
        <td class="num ${b.restant < 0 ? 'negatif' : ''}">${da(b.restant)}</td>
        <td><div class="barre-progres"><span class="${b.niveau}" style="width:${Math.min(b.pourcentage, 100)}%"></span></div><small>${b.pourcentage} %</small></td>
        <td><span class="badge ${b.niveau}">${h(libelleNiveau(b.niveau))}</span></td></tr>`).join('')}</tbody></table></div>`
      : `<p class="vide">${f.registerId ? 'Aucun budget pour ce mois.' : 'Aucune caisse accessible.'}</p>`}`;
  const lier = (c) => {
    const filtre = c.querySelector('[data-form="budget-filtre"]');
    filtre.onsubmit = (e) => { e.preventDefault(); const v = lireForm(filtre); ETAT.filtresBudgets = { mois: v.mois, registerId: v.registerId }; rendre(); };
    const form = c.querySelector('[data-form="budget"]');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const v = lireForm(form);
      try {
        await api('POST', '/budgets', { registerId: Number(f.registerId), categorie: v.categorie, mois: f.mois, montant: v.montant });
        notifier('Budget enregistré.'); rendre();
      } catch (err) { notifier(err.message, 'ko'); }
    };
  };
  return { html, lier };
}

// ---------- Dépenses récurrentes ----------

async function pageRecurrentes() {
  const [liste, recurrentes, echeances, tiersF, tiersB] = await Promise.all([
    caisses(), api('GET', '/recurrentes'), api('GET', '/echeances'),
    api('GET', '/tiers/fournisseurs'), api('GET', '/tiers/beneficiaires')]);
  const html = `<h2>Dépenses récurrentes</h2>
    <p class="muted">Une échéance n'est jamais débitée automatiquement : elle doit être confirmée.</p>
    ${peutGerer() ? `<form data-form="recurrente" class="panneau"><h3>Programmer une dépense</h3><div class="grille-form">
      ${champ({ nom: 'libelle', libelle: 'Libellé', requis: true })}
      ${champ({ nom: 'categorie', libelle: 'Catégorie', options: simples(CATEGORIES_DEPENSE), vide: false, requis: true })}
      ${champ({ nom: 'montant', libelle: 'Montant (DA)', type: 'number', num: true, requis: true, min: 1 })}
      ${champ({ nom: 'frequence', libelle: 'Fréquence', options: FREQUENCES, vide: false, requis: true })}
      ${champ({ nom: 'prochaineEcheance', libelle: 'Prochaine échéance', type: 'date', valeur: aujourdhui(), requis: true })}
      ${champ({ nom: 'registerId', libelle: 'Caisse', num: true, options: optionsCaisses(liste), vide: false, requis: true })}
      ${champ({ nom: 'fournisseurId', libelle: 'Fournisseur', num: true, optionnel: true, options: tiersF.map((x) => [x.id, x.nom]) })}
      ${champ({ nom: 'beneficiaireId', libelle: 'Bénéficiaire', num: true, optionnel: true, options: tiersB.map((x) => [x.id, x.nom]) })}
      ${champ({ nom: 'modePaiement', libelle: 'Mode de paiement', options: MODES, valeur: 'especes', vide: false })}</div>
      <div class="actions"><button class="btn" type="submit">Programmer</button></div></form>` : ''}
    <div class="actions" style="margin-bottom:12px">${peutGerer() ? '<button class="btn-secondaire" data-action="generer">Générer les échéances jusqu\'à aujourd\'hui</button>' : ''}</div>
    <h3>Dépenses programmées</h3>
    ${tableau([
    { libelle: 'Libellé', cle: 'libelle' }, { libelle: 'Catégorie', cle: 'categorie' },
    { libelle: 'Fréquence', cle: 'frequence' }, { libelle: 'Prochaine échéance', rendu: (r) => dateFr(r.prochaine_echeance) },
    { libelle: 'Montant', num: true, rendu: (r) => da(r.montant) },
  ], recurrentes, 'Aucune dépense programmée.')}
    <h3>Échéances</h3>
    ${tableau([
    { libelle: 'Échéance', rendu: (o) => dateFr(o.echeance) }, { libelle: 'Libellé', cle: 'libelle' },
    { libelle: 'Montant', num: true, rendu: (o) => da(o.montant) },
    { libelle: 'Statut', rendu: (o) => `<span class="badge ${o.statut === 'confirmee' ? 'ok' : o.statut === 'proposee' ? 'avertissement' : ''}">${h(o.statut)}</span>` },
    { libelle: '', rendu: (o) => o.statut === 'proposee' ? `<div class="actions"><button class="btn-petit" data-action="confirmer" data-id="${o.id}">Confirmer</button>
      <button class="btn-secondaire btn-petit" data-action="ignorer" data-id="${o.id}">Ignorer</button></div>` : '' },
  ], echeances, 'Aucune échéance.')}`;
  const lier = (c) => {
    const form = c.querySelector('[data-form="recurrente"]');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/recurrentes', lireForm(form)); notifier('Dépense programmée.'); rendre(); }
      catch (err) { notifier(err.message, 'ko'); }
    };
    const gen = c.querySelector('[data-action="generer"]');
    if (gen) gen.onclick = async () => {
      const r = await api('POST', '/recurrentes/generer', { asOf: aujourdhui() });
      notifier(`${r.crees} échéance(s) proposée(s).`); rendre();
    };
    c.querySelectorAll('[data-action="confirmer"]').forEach((b) => {
      b.onclick = async () => { try { await api('POST', `/echeances/${b.dataset.id}/confirmer`, {}); notifier('Échéance confirmée (sortie enregistrée).'); rendre(); } catch (err) { notifier(err.message, 'ko'); } };
    });
    c.querySelectorAll('[data-action="ignorer"]').forEach((b) => {
      b.onclick = async () => { try { await api('POST', `/echeances/${b.dataset.id}/ignorer`, {}); notifier('Échéance ignorée.'); rendre(); } catch (err) { notifier(err.message, 'ko'); } };
    });
  };
  return { html, lier };
}

// ---------- Rapports ----------

const COLONNES_MONTANT = /revenus|depenses|total|montant|solde|reste|encaisse|calcul|mouvement|ecart|resultat|transferts|depense|Ecart|soldeActuel|solde_/i;

function tableauGenerique(donnees) {
  if (!Array.isArray(donnees)) {
    return `<div class="cartes">${Object.entries(donnees).map(([k, v]) => `<div class="carte"><small>${h(k)}</small><div class="valeur">${typeof v === 'number' && COLONNES_MONTANT.test(k) ? da(v) : h(v)}</div></div>`).join('')}</div>`;
  }
  if (!donnees.length) return '<p class="vide">Aucune donnée pour cette période.</p>';
  const cles = Object.keys(donnees[0]).filter((k) => !k.startsWith('_') && !['id', 'register_id', 'fournisseur_id', 'user_id', 'caisse_id'].includes(k));
  return tableau(cles.map((k) => ({
    libelle: k, cle: k, num: typeof donnees[0][k] === 'number',
    rendu: (l) => (typeof l[k] === 'number' && COLONNES_MONTANT.test(k) ? da(l[k]) : h(l[k] ?? '')),
  })), donnees);
}

async function pageRapports() {
  const liste = await caisses();
  const f = ETAT.filtresRapports || { type: 'resume', from: debutMois(), to: aujourdhui(), registerId: '', granularite: 'mois' };
  ETAT.filtresRapports = f;
  const html = `<h2>Rapports et statistiques</h2>
    <form data-form="rapport" class="barre-outils">
      <div class="champ"><label for="r-type">Rapport</label><select id="r-type" name="type">${options([
    ['resume', 'Résumé de la période'], ['periodes', 'Évolution (périodes)'], ['categories', 'Par catégorie'], ['utilisateurs', 'Par utilisateur'],
    ['fournisseurs', 'Par fournisseur'], ['caisses', 'Par caisse'], ['commissions', 'Commissions'], ['clotures', 'Clôtures et écarts'],
  ], f.type)}</select></div>
      <div class="champ"><label for="r-from">Du</label><input type="date" id="r-from" name="from" value="${f.from}"></div>
      <div class="champ"><label for="r-to">Au</label><input type="date" id="r-to" name="to" value="${f.to}"></div>
      <div class="champ"><label for="r-caisse">Caisse</label><select id="r-caisse" name="registerId"><option value="">Toutes</option>${options(optionsCaisses(liste), f.registerId)}</select></div>
      <div class="champ"><label for="r-gran">Granularité</label><select id="r-gran" name="granularite">${options([['jour', 'Jour'], ['semaine', 'Semaine'], ['mois', 'Mois'], ['annee', 'Année']], f.granularite)}</select></div>
      <div class="actions"><button class="btn" type="submit">Afficher</button>
      <button class="btn-secondaire" type="button" data-action="csv">Exporter (CSV)</button></div></form>
    <section class="panneau" id="resultat-rapport"><p class="vide">Chargement…</p></section>`;
  const lier = (c) => {
    const form = c.querySelector('[data-form="rapport"]');
    const charger = async () => {
      const v = lireForm(form);
      ETAT.filtresRapports = { ...f, ...v };
      const zone = $('#resultat-rapport', c);
      zone.innerHTML = '<p class="vide">Chargement…</p>';
      const data = await api('GET', `/rapports/${v.type}${qs({ from: v.from, to: v.to, registerId: v.registerId, granularite: v.granularite })}`);
      if (v.type === 'periodes') {
        zone.innerHTML = `${graphiqueBarres(data, 'periode', 'revenus', 'depenses')}${tableauGenerique(data)}`;
      } else {
        zone.innerHTML = tableauGenerique(data);
      }
    };
    form.onsubmit = (e) => { e.preventDefault(); charger().catch((err) => notifier(err.message, 'ko')); };
    c.querySelector('[data-action="csv"]').onclick = () => {
      const v = lireForm(form);
      window.location.href = `/api/export.csv${qs({ from: v.from, to: v.to, registerId: v.registerId })}`;
    };
    charger().catch((err) => notifier(err.message, 'ko'));
  };
  return { html, lier };
}

// ---------- Utilisateurs (administration) ----------

async function pageUtilisateurs() {
  const liste = await api('GET', '/utilisateurs');
  const caisseListe = await caisses();
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2>Utilisateurs et permissions</h2>
      <button class="btn" data-action="nouvel-utilisateur">+ Nouvel utilisateur</button></div>
    <p class="muted">Rôles : Administrateur (accès total) · Responsable (caisses attribuées, transferts, commissions, corrections) · Caissier (entrées, dépenses, clôture) · Consultation (lecture seule).</p>
    ${tableau([
    { libelle: 'Nom', cle: 'nom' }, { libelle: 'E-mail', cle: 'email' },
    { libelle: 'Rôle', rendu: (u) => h(ROLES.find((r) => r[0] === u.role)?.[1] || u.role) },
    { libelle: 'Caisses', rendu: (u) => u.registerIds.map((id) => h(caisseListe.find((c) => c.id === id)?.nom || id)).join(', ') || '—' },
    { libelle: 'Statut', rendu: (u) => `<span class="badge ${u.actif ? 'ok' : 'alerte'}">${u.actif ? 'Actif' : 'Désactivé'}</span>${u.verrouille_jusqua ? '<br><small>Verrouillé</small>' : ''}` },
    { libelle: '', rendu: (u) => `<button class="btn-petit" data-action="modifier-utilisateur" data-id="${u.id}">Modifier</button>` },
  ], liste)}`;
  const champsUtilisateur = (u = null) => `<div class="grille-form">
      ${champ({ nom: 'nom', libelle: 'Nom', requis: true, valeur: u?.nom || '' })}
      ${u ? '' : champ({ nom: 'email', libelle: 'E-mail (identifiant)', type: 'email', requis: true })}
      ${champ({ nom: 'role', libelle: 'Rôle', options: ROLES, vide: false, requis: true, valeur: u?.role || 'CAISSIER' })}
      ${champ({ nom: 'password', libelle: u ? 'Nouveau mot de passe (facultatif)' : 'Mot de passe (10 caractères min.)', type: 'password', optionnel: true, requis: !u })}
    </div>
    ${u ? `<div class="inline"><input type="checkbox" name="actif" id="u-actif" ${u.actif ? 'checked' : ''}><label for="u-actif">Compte actif</label></div>` : ''}
    <h3>Caisses attribuées</h3>
    ${caisseListe.map((c) => `<div class="inline"><input type="checkbox" name="registerIds" value="${c.id}" data-multi id="cc-${c.id}" ${u?.registerIds?.includes(c.id) ? 'checked' : ''}>
      <label for="cc-${c.id}">${h(c.nom)} <small>(${h(c.code)})</small></label></div>`).join('') || '<p class="muted">Aucune caisse.</p>'}`;
  const lier = (c) => {
    c.querySelector('[data-action="nouvel-utilisateur"]').onclick = () => modal('Nouvel utilisateur', champsUtilisateur(),
      async (v, form, fermer) => { await api('POST', '/utilisateurs', v); fermer(); notifier('Utilisateur créé.'); rendre(); });
    c.querySelectorAll('[data-action="modifier-utilisateur"]').forEach((b) => {
      b.onclick = () => {
        const u = liste.find((x) => String(x.id) === b.dataset.id);
        modal(`Modifier ${u.nom}`, champsUtilisateur(u), async (v, form, fermer) => {
          const corps = { nom: v.nom, role: v.role, actif: !!v.actif, registerIds: v.registerIds || [] };
          if (v.password) corps.password = v.password;
          await api('PUT', `/utilisateurs/${u.id}`, corps);
          fermer(); notifier('Utilisateur mis à jour.'); rendre();
        });
      };
    });
  };
  return { html, lier };
}

// ---------- Journal ----------

async function pageJournal() {
  const f = ETAT.filtresJournal || { from: debutMois(), to: aujourdhui(), action: '' };
  ETAT.filtresJournal = f;
  const lignes = await api('GET', `/journal${qs(f)}`);
  const html = `<h2>Journal d'activité</h2>
    <p class="muted">Journal immuable : chaque création, correction, clôture, réouverture et modification de droits y figure.</p>
    <form data-form="journal" class="barre-outils">
      <div class="champ"><label for="j-from">Du</label><input type="date" id="j-from" name="from" value="${f.from}"></div>
      <div class="champ"><label for="j-to">Au</label><input type="date" id="j-to" name="to" value="${f.to}"></div>
      <div class="champ"><label for="j-action">Action</label><select id="j-action" name="action"><option value="">Toutes</option>${options(simples(ACTIONS_JOURNAL), f.action)}</select></div>
      <div class="actions"><button class="btn-secondaire" type="submit">Filtrer</button></div></form>
    ${tableau([
    { libelle: 'Date', rendu: (a) => h(String(a.created_at).replace('T', ' ').slice(0, 16)) },
    { libelle: 'Utilisateur', rendu: (a) => h(a.utilisateur || 'Système') },
    { libelle: 'Action', rendu: (a) => `<code>${h(a.action)}</code>` },
    { libelle: 'Entité', rendu: (a) => `${h(a.entite)}${a.entite_id ? ` #${a.entite_id}` : ''}` },
    { libelle: 'Détail', rendu: (a) => `<small>${h((a.donnees_apres || a.donnees_avant || '').slice(0, 160))}</small>` },
  ], lignes, 'Aucune action sur la période.')}`;
  const lier = (c) => {
    const form = c.querySelector('[data-form="journal"]');
    form.onsubmit = (e) => { e.preventDefault(); const v = lireForm(form); ETAT.filtresJournal = { from: v.from, to: v.to, action: v.action }; rendre(); };
  };
  return { html, lier };
}

// ---------- Notifications ----------

async function pageNotifications() {
  const f = ETAT.filtresNotifs || 'non-lues';
  const lignes = await api('GET', f === 'non-lues' ? '/notifications?lue=0' : '/notifications');
  const html = `<div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2>Notifications</h2>
      <div class="actions"><button class="btn-secondaire" data-action="sync">Actualiser les alertes</button></div></div>
    <div class="onglets">${[['non-lues', 'Non lues'], ['toutes', 'Toutes']].map(([id, l]) => `<button type="button" data-filtre="${id}" class="${f === id ? 'actif' : ''}">${l}</button>`).join('')}</div>
    ${lignes.length ? `<ul class="alertes">${lignes.map((n) => `<li class="${h(n.niveau)} ${n.lue ? 'lue' : ''}">
      <span class="badge ${h(n.niveau)}">${h(libelleNiveau(n.niveau))}</span>
      <span style="flex:1">${h(n.message)}<br><small>${h(String(n.created_at).slice(0, 16))}</small></span>
      ${n.lien ? `<a class="btn-petit" href="#${h(n.lien)}">Ouvrir</a>` : ''}
      ${n.lue ? '' : `<button class="btn-secondaire btn-petit" data-lue="${n.id}">Marquer lue</button>`}</li>`).join('')}</ul>`
      : '<p class="vide">Aucune notification.</p>'}`;
  const lier = (c) => {
    c.querySelectorAll('[data-filtre]').forEach((b) => { b.onclick = () => { ETAT.filtresNotifs = b.dataset.filtre; rendre(); }; });
    c.querySelector('[data-action="sync"]').onclick = async () => {
      const r = await api('POST', '/notifications/synchroniser', {});
      notifier(`${r.crees} nouvelle(s) notification(s).`); rendre();
    };
    c.querySelectorAll('[data-lue]').forEach((b) => { b.onclick = async () => { await api('POST', `/notifications/${b.dataset.lue}/lue`, {}); rendre(); }; });
  };
  return { html, lier };
}

// ---------- Paramètres ----------

async function pageParametres() {
  const s = await api('GET', '/parametres');
  const html = `<h2>Paramètres de la société</h2>
    <form data-form="parametres" class="panneau"><div class="grille-form">
      ${champ({ nom: 'societe_nom', libelle: 'Nom de la société', valeur: s.societe_nom })}
      ${champ({ nom: 'societe_telephone', libelle: 'Téléphone', valeur: s.societe_telephone || '', optionnel: true })}
      ${champ({ nom: 'societe_adresse', libelle: 'Adresse', valeur: s.societe_adresse || '', optionnel: true })}
      ${champ({ nom: 'devise', libelle: 'Devise', valeur: s.devise, aide: 'Dinar algérien : DA' })}
      ${champ({ nom: 'fuseau_horaire', libelle: 'Fuseau horaire', valeur: s.fuseau_horaire, aide: 'Africa/Algiers' })}
      ${champ({ nom: 'format_date', libelle: 'Format de date', valeur: s.format_date, aide: 'DD/MM/YYYY' })}</div>
      <div class="actions"><button class="btn" type="submit">Enregistrer</button></div></form>
    <section class="panneau"><h3>Sauvegardes</h3><p>Les données sont conservées dans le journal financier (stockage SQLite du service). Exportez régulièrement vos opérations en CSV depuis la page Rapports pour une copie externe.</p></section>`;
  const lier = (c) => {
    c.querySelector('[data-form="parametres"]').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', '/parametres', lireForm(e.target)); notifier('Paramètres enregistrés.'); }
      catch (err) { notifier(err.message, 'ko'); }
    };
  };
  return { html, lier };
}

// ---------- Navigation et routage ----------

const PAGES = [
  { id: 'tableau-de-bord', libelle: 'Tableau de bord', groupe: 'Pilotage', rendre: pageTableauDeBord },
  { id: 'caisses', libelle: 'Caisses', groupe: 'Trésorerie', rendre: pageCaisses },
  { id: 'operations', libelle: 'Entrées et dépenses', groupe: 'Trésorerie', rendre: pageOperations },
  { id: 'transferts', libelle: 'Transferts', groupe: 'Trésorerie', roles: ['ADMINISTRATEUR', 'RESPONSABLE'], rendre: pageTransferts },
  { id: 'clotures', libelle: 'Clôtures', groupe: 'Trésorerie', rendre: pageClotures },
  { id: 'commissions', libelle: 'Commissions', groupe: 'Trésorerie', roles: ['ADMINISTRATEUR', 'RESPONSABLE'], rendre: pageCommissions },
  { id: 'fournisseurs', libelle: 'Fournisseurs', groupe: 'Dépenses', rendre: () => pageTiers('fournisseurs') },
  { id: 'beneficiaires', libelle: 'Bénéficiaires', groupe: 'Dépenses', rendre: () => pageTiers('beneficiaires') },
  { id: 'budgets', libelle: 'Budgets', groupe: 'Dépenses', rendre: pageBudgets },
  { id: 'recurrentes', libelle: 'Dépenses récurrentes', groupe: 'Dépenses', rendre: pageRecurrentes },
  { id: 'rapports', libelle: 'Rapports', groupe: 'Analyse', rendre: pageRapports },
  { id: 'notifications', libelle: 'Notifications', groupe: 'Administration', roles: ['ADMINISTRATEUR', 'RESPONSABLE'], rendre: pageNotifications },
  { id: 'utilisateurs', libelle: 'Utilisateurs', groupe: 'Administration', roles: ['ADMINISTRATEUR'], rendre: pageUtilisateurs },
  { id: 'journal', libelle: "Journal d'activité", groupe: 'Administration', roles: ['ADMINISTRATEUR'], rendre: pageJournal },
  { id: 'parametres', libelle: 'Paramètres', groupe: 'Administration', roles: ['ADMINISTRATEUR'], rendre: pageParametres },
];

function construireNavigation() {
  const visibles = PAGES.filter((p) => !p.roles || p.roles.includes(ETAT.user.role));
  let groupe = '';
  $('#navigation').innerHTML = visibles.map((p) => {
    const entete = p.groupe !== groupe ? `<div class="groupe">${h(p.groupe)}</div>` : '';
    groupe = p.groupe;
    return `${entete}<a href="#/${p.id}" data-page="${p.id}">${h(p.libelle)}</a>`;
  }).join('');
}

async function rendre() {
  if (!ETAT.user) return;
  const segments = location.hash.replace(/^#\/?/, '').split('/');
  const [seg0, seg1] = segments;
  const contenu = $('#contenu');
  let titre = 'Tableau de bord';
  let fonction = pageTableauDeBord;
  let actif = 'tableau-de-bord';
  if (seg0 === 'caisses' && seg1) {
    titre = 'Fiche caisse';
    fonction = () => pageCaisseDetail(seg1);
    actif = 'caisses';
  } else if (seg0 === 'fournisseurs' && seg1) {
    titre = 'Fournisseurs';
    fonction = () => pageTiers('fournisseurs', seg1);
    actif = 'fournisseurs';
  } else if (seg0 === 'beneficiaires' && seg1) {
    titre = 'Bénéficiaires';
    fonction = () => pageTiers('beneficiaires', seg1);
    actif = 'beneficiaires';
  } else if (seg0) {
    const page = PAGES.find((p) => p.id === seg0);
    if (page) { titre = page.libelle; fonction = page.rendre; actif = page.id; }
  }
  const page = PAGES.find((p) => p.id === actif);
  $('#titre-page').textContent = titre;
  document.querySelectorAll('#navigation a').forEach((a) => a.classList.toggle('actif', a.dataset.page === actif));
  $('.menu').classList.remove('ouvert');
  if (page?.roles && !page.roles.includes(ETAT.user.role)) {
    contenu.innerHTML = '<p class="vide">Accès refusé : cette page n\'est pas disponible pour votre rôle.</p>';
    return;
  }
  contenu.innerHTML = '<p class="vide">Chargement…</p>';
  try {
    const { html, lier } = await fonction();
    contenu.innerHTML = html;
    if (lier) lier(contenu);
  } catch (err) {
    if (err.status === 401) { ETAT.user = null; afficherAuth('login'); return; }
    contenu.innerHTML = `<p class="erreur" role="alert">${h(err.message)}</p>`;
  }
}

// ---------- Écrans d'accès ----------

function afficherAuth(mode = 'login') {
  $('#application').hidden = true;
  const ecran = $('#ecran-auth');
  ecran.hidden = false;
  if (mode === 'setup') {
    ecran.innerHTML = `<form class="auth-carte" novalidate>
      <h2>Première installation</h2>
      <p class="muted">Créez le compte administrateur de MT Delivery. Ce compte gère les caisses, les utilisateurs et les paramètres.</p>
      ${champ({ nom: 'nom', libelle: 'Nom complet', requis: true })}
      ${champ({ nom: 'email', libelle: 'E-mail', type: 'email', requis: true })}
      ${champ({ nom: 'password', libelle: 'Mot de passe (10 caractères minimum)', type: 'password', requis: true })}
      <p class="erreur" role="alert" data-erreur></p>
      <button class="btn" type="submit" style="width:100%">Créer le compte administrateur</button></form>`;
    ecran.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const v = lireForm(e.target);
      try {
        await api('POST', '/setup', v);
        const r = await api('POST', '/connexion', { email: v.email, password: v.password });
        ETAT.user = r.user;
        demarrerApp();
      } catch (err) { ecran.querySelector('[data-erreur]').textContent = err.message; }
    };
    return;
  }
  ecran.innerHTML = `<form class="auth-carte" novalidate>
    <div class="marque" style="border:0;padding:0;margin-bottom:16px"><span class="logo">MT</span><div><strong>MT Delivery</strong><small>Gestion de caisse</small></div></div>
    <h2>Connexion</h2>
    ${champ({ nom: 'email', libelle: 'E-mail', type: 'email', requis: true })}
    ${champ({ nom: 'password', libelle: 'Mot de passe', type: 'password', requis: true })}
    <p class="erreur" role="alert" data-erreur></p>
    <button class="btn" type="submit" style="width:100%">Se connecter</button></form>`;
  ecran.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const v = lireForm(e.target);
    try {
      const r = await api('POST', '/connexion', v);
      ETAT.user = r.user;
      demarrerApp();
    } catch (err) { ecran.querySelector('[data-erreur]').textContent = err.message; }
  };
}

function demarrerApp() {
  $('#ecran-auth').hidden = true;
  $('#application').hidden = false;
  $('#utilisateur').textContent = `${ETAT.user.nom} · ${ROLES.find((r) => r[0] === ETAT.user.role)?.[1] || ''}`;
  construireNavigation();
  if (!location.hash || location.hash === '#') location.hash = '#/tableau-de-bord';
  rendre();
}

async function demarrer() {
  appliquerTheme(localStorage.getItem('mt-theme') || 'clair');
  const etat = await api('GET', '/etat').catch(() => ({ initialise: true }));
  if (!etat.initialise) return afficherAuth('setup');
  try {
    const s = await api('GET', '/session');
    ETAT.user = s.user;
    demarrerApp();
  } catch {
    afficherAuth('login');
  }
}

function appliquerTheme(theme) {
  document.documentElement.dataset.theme = theme === 'sombre' ? 'sombre' : 'clair';
  localStorage.setItem('mt-theme', theme);
}

// ---------- Liaisons globales ----------

window.addEventListener('hashchange', rendre);
$('#bouton-menu').onclick = () => $('.menu').classList.toggle('ouvert');
$('#bascule-theme').onclick = () => appliquerTheme(document.documentElement.dataset.theme === 'sombre' ? 'clair' : 'sombre');
$('#deconnexion').onclick = async () => {
  await api('POST', '/deconnexion', {}).catch(() => {});
  ETAT.user = null;
  location.hash = '';
  afficherAuth('login');
};

demarrer();
