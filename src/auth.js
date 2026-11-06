'use strict';

// Authentification : mots de passe PBKDF2-SHA256 (WebCrypto, disponible dans Node 22 et Cloudflare Workers),
// sessions à jeton aléatoire dont seul le hachage est stocké, verrouillage après échecs répétés.

const { FinanceError } = require('./finance');

const ITERATIONS = 100000; // maximum accepté par Cloudflare Workers
const SESSION_HEURES = 12;
const ECHECS_AVANT_VERROU = 6;
const VERROU_MINUTES = 15;
const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new FinanceError('MOT_DE_PASSE_FAIBLE', 'Le mot de passe doit contenir au moins 10 caractères.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

function egalConstant(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, iterations, saltHex, hash] = stored.split('$');
  if (alg !== 'pbkdf2' || !saltHex || !hash) return false;
  return egalConstant(await pbkdf2(password, fromHex(saltHex), Number(iterations)), hash);
}

async function sha256Hex(texte) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(texte)));
}

function jetonAleatoire() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function maintenantIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

async function login(db, { email, password }) {
  const u = db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [(email || '').trim()]);
  const refus = () => { throw new FinanceError('CONNEXION_INVALIDE', 'Identifiants incorrects.'); };
  if (!u || !u.actif) refus();
  if (u.verrouille_jusqua && u.verrouille_jusqua > maintenantIso()) {
    throw new FinanceError('COMPTE_VERROUILLE', 'Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.');
  }
  const ok = await verifyPassword(password || '', u.password_hash);
  if (!ok) {
    const n = u.echecs_connexion + 1;
    if (n >= ECHECS_AVANT_VERROU) {
      db.run('UPDATE users SET echecs_connexion = 0, verrouille_jusqua = ? WHERE id = ?', [maintenantIso(Date.now() + VERROU_MINUTES * 60000), u.id]);
    } else {
      db.run('UPDATE users SET echecs_connexion = ? WHERE id = ?', [n, u.id]);
    }
    refus();
  }
  db.run('UPDATE users SET echecs_connexion = 0, verrouille_jusqua = NULL WHERE id = ?', [u.id]);
  const token = jetonAleatoire();
  db.run('INSERT INTO sessions (user_id, token_hash, expire_le) VALUES (?, ?, ?)',
    [u.id, await sha256Hex(token), maintenantIso(Date.now() + SESSION_HEURES * 3600000)]);
  return { token, user: { id: u.id, nom: u.nom, email: u.email, role: u.role } };
}

async function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', [await sha256Hex(token)]);
}

// Retourne l'acteur (identité + rôle + caisses attribuées) rattaché à la session, ou null.
async function loadActor(db, token) {
  if (!token) return null;
  const s = db.get(
    `SELECT u.id, u.nom, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expire_le > ? AND u.actif = 1`,
    [await sha256Hex(token), maintenantIso()],
  );
  if (!s) return null;
  const registres = db.all('SELECT register_id FROM cash_register_users WHERE user_id = ?', [s.id]).map((r) => r.register_id);
  return { userId: s.id, nom: s.nom, email: s.email, role: s.role, registerIds: registres };
}

module.exports = {
  hashPassword,
  verifyPassword,
  login,
  logout,
  loadActor,
  sha256Hex,
  ITERATIONS,
  ECHECS_AVANT_VERROU,
};
