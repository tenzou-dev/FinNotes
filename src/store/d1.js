'use strict';

/**
 * Store FinNotes di atas dialect SQLite, diakses lewat antarmuka ala
 * binding D1 Cloudflare. Dipakai dua-duanya oleh:
 *
 *  - Worker produksi: configure() menerima binding D1 (env.DB)
 *  - Server lokal & test: configure() menerima adapter node:sqlite
 *    (src/store/node-d1.js) -- schema dan perilaku persis sama.
 *
 * Tidak memakai API Node sama sekali (WebCrypto global, tanpa fs) supaya
 * bisa ikut ter-bundle ke Workers tanpa polyfill.
 *
 * Kontrak argumen mengikuti store Supabase yang lama: argumen pertama
 * selalu accessToken. Di sini token adalah sesi kita sendiri (hex);
 * hanya createHousehold/joinHousehold yang benar-benar memakainya untuk
 * mengidentifikasi user -- sisanya mengandalkan userId/householdId
 * eksplisit yang sudah lolos requireAuth/requireHousehold di route.
 */

const { SCHEMA_STATEMENTS } = require('./schema');

let DB = null;
let ITERATIONS = 10000; // PBKDF2-SHA256; ~3,5ms di Node, aman utk limit CPU Workers free (10ms)
let SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
let readyPromise = null;

/* ---------------- infra query ---------------- */

async function rawFirst(sql, ...params) {
  return await DB.prepare(sql).bind(...params).first();
}

async function rawAll(sql, ...params) {
  const r = await DB.prepare(sql).bind(...params).all();
  return r.results || [];
}

async function rawRun(sql, ...params) {
  const r = await DB.prepare(sql).bind(...params).run();
  return r.meta?.changes ?? 0;
}

async function ensureSchema() {
  // Satu query murah saat cold start isolat; DDL hanya dijalankan kalau
  // tabel belum ada (semua statement idempotent).
  const probe = await rawFirst("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'");
  if (probe) return;
  // Lewat prepare().run(), bukan exec(): exec() di D1 asli tidak mendukung
  // SQL multi-baris (D1_EXEC_ERROR: incomplete input), sedangkan prepare()
  // mem-parse statement utuh seperti semua query lain. Di adapter node:sqlite
  // keduanya jalan, jadi satu jalur ini aman untuk dua-duanya.
  for (const stmt of SCHEMA_STATEMENTS) await rawRun(stmt);
}

async function gate() {
  if (readyPromise) await readyPromise;
}

function configure({ db, iterations, sessionTtlMs } = {}) {
  if (!db) throw new Error('d1.configure: db wajib diisi (binding D1 atau adapter node:sqlite)');
  DB = db;
  const iter = Number(iterations);
  if (Number.isInteger(iter) && iter >= 1000) ITERATIONS = iter;
  const ttl = Number(sessionTtlMs);
  if (Number.isInteger(ttl) && ttl > 0) SESSION_TTL_MS = ttl;
  readyPromise = ensureSchema();
  return readyPromise; // bisa di-await pemanggil (boot Worker)
}

/* ---------------- kripto (WebCrypto global) ---------------- */

function bytesToHex(buf) {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const randHex = (n) => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const uuid = () => globalThis.crypto.randomUUID();
const enc = (s) => new TextEncoder().encode(String(s));

/** format: pbkdf2$iterasi$salt$hash -- iterasi ikut tersimpan supaya
 *  default bisa dinaikkan tanpa memutus user lama. */
async function hashPassword(password) {
  const salt = randHex(16);
  const key = await globalThis.crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: ITERATIONS }, key, 256
  );
  return `pbkdf2$${ITERATIONS}$${salt}$${bytesToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = Number(parts[1]);
    if (!Number.isInteger(iter) || iter < 1000 || iter > 10_000_000) return false;
    const key = await globalThis.crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await globalThis.crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc(parts[2]), iterations: iter }, key, 256
    ));
    const want = hexToBytes(parts[3]);
    if (bits.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}

function makeCode() {
  // 32 huruf tanpa yang mudah tertukar (0/O, 1/I); modulo 2^8 tepat 32 -> tanpa bias
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = globalThis.crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of rnd) out += alphabet[b % 32];
  return out;
}

/* ---------------- bentuk baris ---------------- */

const publicUser = (u) => (u
  ? { id: u.id, email: u.email, name: u.display_name || String(u.email).split('@')[0] }
  : null);

function householdRow(h) {
  if (!h) return null;
  const out = { id: h.id, name: h.name, join_code: h.join_code, currency: h.currency || 'IDR', created_at: h.created_at };
  if (h.role != null) out.role = h.role;
  return out;
}

const txRow = (t) => (t ? {
  id: t.id, type: t.type, amount: Number(t.amount), category: t.category,
  note: t.note || '', raw: t.raw, date: t.date,
  authorId: t.user_id, author: t.author || null, createdAt: t.created_at,
} : null);

const TX_SELECT = `
  SELECT t.*, COALESCE(u.display_name, u.email) AS author
    FROM transactions t LEFT JOIN users u ON u.id = t.user_id
   WHERE t.household_id = ? AND t.id = ?`;

/* ---------------- sesi ---------------- */

async function createSession(userId) {
  // bersihkan sesi kedaluwarsa saat ada login baru: murah dan jarang
  await rawRun('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  const token = randHex(32);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await rawRun('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, expiresAt);
  return { token, expiresAt };
}

async function userFromToken(token) {
  if (!token) return null;
  const row = await rawFirst(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
    token, Date.now()
  );
  return row || null;
}

async function logout(token) {
  if (!token || !DB) return 0;
  await gate();
  return rawRun('DELETE FROM sessions WHERE token = ?', token);
}

/* ---------------- auth: email/password ---------------- */

async function signUp({ email, password, name, householdName, joinCode } = {}) {
  await gate();
  const clean = String(email || '').trim().toLowerCase();
  if (!clean.includes('@') || clean.length < 5) throw new Error('Email tidak valid');
  const pw = String(password || '');
  if (pw.length < 6) throw new Error('Password minimal 6 karakter');
  if (await rawFirst('SELECT id FROM users WHERE email = ?', clean)) throw new Error('Email sudah terdaftar');

  // Kode undangan dicek SEBELUM akun dibuat -> tidak ada lagi akun
  // setengah jadi + household cadangan seperti era Supabase (yang tidak
  // bisa di-rollback). Kode salah = 400 polos.
  const code = String(joinCode || '').trim().toUpperCase();
  let target = null;
  if (code) {
    target = await rawFirst('SELECT * FROM households WHERE join_code = ?', code);
    if (!target) throw new Error('Kode undangan tidak ditemukan');
  }

  const id = uuid();
  await rawRun(
    'INSERT INTO users (id, email, password_hash, display_name) VALUES (?,?,?,?)',
    id, clean, await hashPassword(pw), String(name || '').trim() || clean.split('@')[0]
  );

  let household;
  if (target) {
    await rawRun('INSERT OR IGNORE INTO household_members (household_id, user_id, role) VALUES (?,?,?)', target.id, id, 'member');
    household = householdRow(target);
  } else {
    household = await insertHousehold(String(householdName || '').trim() || 'Rumah Tangga', id, 'owner');
  }
  const s = await createSession(id);
  return { user: publicUser(await rawFirst('SELECT * FROM users WHERE id = ?', id)), household, ...s };
}

async function signIn({ email, password } = {}) {
  await gate();
  const clean = String(email || '').trim().toLowerCase();
  const u = await rawFirst('SELECT * FROM users WHERE email = ?', clean);
  if (!u || !u.password_hash || !(await verifyPassword(String(password || ''), u.password_hash))) {
    throw new Error('Email atau password salah');
  }
  const s = await createSession(u.id);
  return { user: publicUser(u), households: await listHouseholds(null, u.id), ...s };
}

async function signInWithGoogle({ sub, email, name } = {}) {
  await gate();
  if (!sub) throw new Error('Identitas Google tidak valid');
  const gsub = String(sub);
  const clean = String(email || '').trim().toLowerCase();

  let u = await rawFirst('SELECT * FROM users WHERE google_sub = ?', gsub);
  if (!u && clean) {
    // user yang dulu mendaftar dengan email+password lalu mencoba Google:
    // hubungkan akunnya (google_sub masih kosong) supaya tidak dobel.
    const same = await rawFirst('SELECT * FROM users WHERE email = ?', clean);
    if (same) {
      if (same.google_sub && same.google_sub !== gsub) throw new Error('Email ini sudah terhubung ke akun Google lain');
      await rawRun('UPDATE users SET google_sub = ? WHERE id = ?', gsub, same.id);
      u = await rawFirst('SELECT * FROM users WHERE id = ?', same.id);
    }
  }
  if (!u) {
    if (!clean.includes('@')) throw new Error('Email Google tidak tersedia');
    const id = uuid();
    await rawRun(
      'INSERT INTO users (id, email, password_hash, google_sub, display_name) VALUES (?,?,?,?,?)',
      id, clean, null, gsub, String(name || '').trim() || clean.split('@')[0]
    );
    u = await rawFirst('SELECT * FROM users WHERE id = ?', id);
  }

  // Idempotent seperti setup_my_household dulu: user yang sudah punya
  // buku mendapat buku lamanya, user baru mendapat buku baru.
  const households = await listHouseholds(null, u.id);
  const household = households[0] || (await insertHousehold('Rumah Tangga', u.id, 'owner'));
  const s = await createSession(u.id);
  return { user: publicUser(u), household, households: households.length ? households : [household], ...s };
}

async function getSession(token) {
  if (!token || !DB) return null;
  await gate();
  const u = await userFromToken(token);
  if (!u) return null;
  return { user: publicUser(u), households: await listHouseholds(null, u.id) };
}

/* ---------------- household ---------------- */

async function insertHousehold(name, ownerId, role) {
  let code = makeCode();
  while (await rawFirst('SELECT id FROM households WHERE join_code = ?', code)) code = makeCode();
  const id = uuid();
  await rawRun('INSERT INTO households (id, name, join_code) VALUES (?,?,?)', id, name, code);
  if (ownerId) {
    await rawRun('INSERT OR IGNORE INTO household_members (household_id, user_id, role) VALUES (?,?,?)', id, ownerId, role || 'member');
  }
  return householdRow(await rawFirst('SELECT * FROM households WHERE id = ?', id));
}

async function listHouseholds(_t, userId) {
  await gate();
  const rows = await rawAll(
    `SELECT h.*, m.role
       FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ?
      ORDER BY h.created_at ASC, h.id ASC`,
    userId
  );
  return rows.map(householdRow);
}

async function createHousehold(accessToken, name) {
  await gate();
  const user = await userFromToken(accessToken);
  if (!user) throw new Error('Sesi tidak valid, silakan masuk ulang');
  const existing = await rawFirst(
    `SELECT h.*, m.role
       FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? ORDER BY h.created_at ASC LIMIT 1`,
    user.id
  );
  if (existing) return householdRow(existing);
  return insertHousehold(String(name || '').trim() || 'Rumah Tangga', user.id, 'owner');
}

async function joinHousehold(accessToken, code) {
  await gate();
  const user = await userFromToken(accessToken);
  if (!user) throw new Error('Sesi tidak valid, silakan masuk ulang');
  const clean = String(code || '').trim().toUpperCase();
  const h = await rawFirst('SELECT * FROM households WHERE join_code = ?', clean);
  if (!h) throw new Error('Kode undangan tidak ditemukan');
  await rawRun('INSERT OR IGNORE INTO household_members (household_id, user_id, role) VALUES (?,?,?)', h.id, user.id, 'member');
  return householdRow(h);
}

async function getMembership(_t, userId, householdId) {
  await gate();
  const m = await rawFirst('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?', householdId, userId);
  if (!m) throw new Error('Akses ditolak');
  return m;
}

async function listMembers(_t, householdId) {
  await gate();
  const rows = await rawAll(
    `SELECT u.id, u.email, u.display_name, m.role
       FROM household_members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ?
      ORDER BY m.created_at ASC, u.display_name ASC`,
    householdId
  );
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.display_name || String(r.email).split('@')[0], role: r.role }));
}

async function getUserById(_t, id) {
  await gate();
  return publicUser(await rawFirst('SELECT * FROM users WHERE id = ?', id));
}

async function getHousehold(_t, id) {
  await gate();
  return householdRow(await rawFirst('SELECT * FROM households WHERE id = ?', id));
}

/* ---------------- transaksi ---------------- */

async function insertTransaction(_t, householdId, userId, tx) {
  await gate();
  const id = uuid();
  await rawRun(
    'INSERT INTO transactions (id, household_id, user_id, type, amount, category, note, raw, date) VALUES (?,?,?,?,?,?,?,?,?)',
    id, householdId, userId || null, tx.type, Math.round(Number(tx.amount)), tx.category,
    tx.note == null ? '' : tx.note, tx.raw || null, tx.date
  );
  return txRow(await rawFirst(TX_SELECT, householdId, id));
}

async function listTransactions(_t, householdId, limit) {
  await gate();
  const n = Number(limit);
  const sql = `
    SELECT t.*, COALESCE(u.display_name, u.email) AS author
      FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.household_id = ?
     ORDER BY t.date DESC, t.created_at DESC, t.rowid DESC
     ${n > 0 ? 'LIMIT ?' : ''}`;
  const rows = n > 0 ? await rawAll(sql, householdId, n) : await rawAll(sql, householdId);
  return rows.map(txRow);
}

async function getTransaction(_t, householdId, id) {
  await gate();
  return txRow(await rawFirst(TX_SELECT, householdId, id));
}

async function updateTransaction(_t, householdId, id, patch) {
  await gate();
  const cur = await rawFirst(TX_SELECT, householdId, id);
  if (!cur) return null;
  const amount = patch.amount != null && Number.isFinite(Number(patch.amount))
    ? Math.round(Number(patch.amount)) : cur.amount;
  await rawRun(
    'UPDATE transactions SET type=?, amount=?, category=?, note=?, date=? WHERE household_id=? AND id=?',
    patch.type || cur.type,
    amount,
    patch.category != null ? patch.category : cur.category,
    patch.note != null ? patch.note : cur.note,
    patch.date || cur.date,
    householdId, id
  );
  return txRow(await rawFirst(TX_SELECT, householdId, id));
}

async function deleteTransaction(_t, householdId, id) {
  await gate();
  return (await rawRun('DELETE FROM transactions WHERE household_id = ? AND id = ?', householdId, id)) > 0;
}

async function deleteAllTransactions(_t, householdId) {
  await gate();
  return rawRun('DELETE FROM transactions WHERE household_id = ?', householdId);
}

async function deleteLastTransaction(_t, householdId) {
  await gate();
  const t = await rawFirst(
    `SELECT t.*, COALESCE(u.display_name, u.email) AS author
       FROM transactions t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.household_id = ?
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
    householdId
  );
  if (!t) return null;
  await rawRun('DELETE FROM transactions WHERE household_id = ? AND id = ?', householdId, t.id);
  return txRow(t);
}

/* ---------------- agregat ---------------- */

async function totals(_t, householdId) {
  await gate();
  const r = await rawFirst(
    `SELECT COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense,
            COUNT(*) AS n
       FROM transactions WHERE household_id = ?`,
    householdId
  );
  const income = Number(r?.income || 0);
  const expense = Number(r?.expense || 0);
  return { income, expense, balance: income - expense, count: Number(r?.n || 0) };
}

async function rangeAgg(householdId, from, to) {
  const r = await rawFirst(
    `SELECT COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense,
            COUNT(*) AS n
       FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`,
    householdId, from, to
  );
  const income = Number(r?.income || 0);
  const expense = Number(r?.expense || 0);
  return { income, expense, net: income - expense, count: Number(r?.n || 0) };
}

async function periodTotals(_t, householdId, from, to) {
  await gate();
  return { ...(await rangeAgg(householdId, from, to)), from, to };
}

async function previousPeriodTotals(_t, householdId, from, to) {
  await gate();
  if (from < '2000-01-01') return { income: 0, expense: 0, net: 0, count: 0, from: null, to: null, available: false };
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to + 'T00:00:00');
  const span = Math.round((t - f) / 86400000) + 1;
  const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - span + 1);
  const p = (d) => d.toISOString().slice(0, 10);
  return { ...(await rangeAgg(householdId, p(prevFrom), p(prevTo))), from: p(prevFrom), to: p(prevTo), available: true };
}

async function topCategories(_t, householdId, type, from, to) {
  await gate();
  const rows = await rawAll(
    `SELECT category, type, SUM(amount) AS total, COUNT(*) AS n
       FROM transactions
      WHERE household_id = ? AND type = ? AND date BETWEEN ? AND ?
      GROUP BY category ORDER BY total DESC`,
    householdId, type, from, to
  );
  return rows.map((r) => ({ category: r.category, type: r.type, total: Number(r.total), count: Number(r.n) }));
}

async function dailySeries(_t, householdId, from, to) {
  await gate();
  const rows = await rawAll(
    `SELECT date,
            COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
       FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?
      GROUP BY date ORDER BY date`,
    householdId, from, to
  );
  return rows.map((r) => ({ date: r.date, income: Number(r.income), expense: Number(r.expense) }));
}

async function activeDays(_t, householdId, limit = 30) {
  await gate();
  const rows = await rawAll(
    'SELECT DISTINCT date FROM transactions WHERE household_id = ? ORDER BY date DESC LIMIT ?',
    householdId, Number(limit)
  );
  return rows.map((r) => r.date);
}

/* ---------------- chat ---------------- */

async function insertMessage(_t, householdId, userId, role, text, payload) {
  await gate();
  const id = uuid();
  await rawRun(
    'INSERT INTO messages (id, household_id, user_id, role, text, payload) VALUES (?,?,?,?,?,?)',
    id, householdId, userId || null, role, String(text), payload ? JSON.stringify(payload) : null
  );
  return { id };
}

async function lastMessages(_t, householdId, limit = 50) {
  await gate();
  const rows = await rawAll(
    'SELECT * FROM messages WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    householdId, Number(limit)
  );
  return rows.reverse().map((m) => ({
    id: m.id, role: m.role, text: m.text,
    payload: m.payload ? JSON.parse(m.payload) : null,
    createdAt: m.created_at,
  }));
}

module.exports = {
  BACKEND: 'd1',
  IS_ASYNC: true,
  configure,
  signUp, signIn, signInWithGoogle, getSession, logout,
  createHousehold, joinHousehold, listHouseholds, getMembership, listMembers,
  getUserById, getHousehold,
  insertTransaction, listTransactions, getTransaction, updateTransaction,
  deleteTransaction, deleteLastTransaction, deleteAllTransactions,
  totals, periodTotals, previousPeriodTotals, topCategories, dailySeries, activeDays,
  insertMessage, lastMessages,
};
