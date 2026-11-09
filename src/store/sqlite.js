'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.SQLITE_FILE || path.join(__dirname, '..', '..', 'data', 'app-v2.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'IDR',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS household_members (
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id TEXT,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  raw TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tx_h ON transactions (household_id, date DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_h ON messages (household_id, created_at DESC);
`);

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const S = {
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?,?,?,?)'),
  insertHousehold: db.prepare('INSERT INTO households (id, name, join_code) VALUES (?,?,?)'),
  householdByCode: db.prepare('SELECT * FROM households WHERE join_code = ?'),
  householdById: db.prepare('SELECT * FROM households WHERE id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO household_members (household_id, user_id, role) VALUES (?,?,?)'),
  listMemberships: db.prepare('SELECT * FROM household_members WHERE user_id = ?'),
  listMembers: db.prepare(
    'SELECT u.id, u.email, u.display_name, m.role FROM household_members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ?'
  ),

  updateTx: db.prepare(
    'UPDATE transactions SET type=?, amount=?, category=?, note=?, date=? WHERE household_id=? AND id=?'
  ),

  insertTx: db.prepare(
    'INSERT INTO transactions (id, household_id, user_id, type, amount, category, note, raw, date) VALUES (?,?,?,?,?,?,?,?,?)'
  ),
  allTx: db.prepare(
    `SELECT t.*, COALESCE(u.display_name, u.email) AS author
     FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.household_id = ? ORDER BY t.date DESC, t.created_at DESC, t.rowid DESC`
  ),
  txById: db.prepare('SELECT * FROM transactions WHERE household_id = ? AND id = ?'),
  deleteTx: db.prepare('DELETE FROM transactions WHERE household_id = ? AND id = ?'),
  deleteAllTx: db.prepare('DELETE FROM transactions WHERE household_id = ?'),
  lastTx: db.prepare(
    'SELECT * FROM transactions WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ),
  sumAll: db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
            COUNT(*) AS n FROM transactions WHERE household_id = ?`
  ),
  sumRange: db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
            COUNT(*) AS n FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`
  ),
  prevRange: db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
            COUNT(*) AS n FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`
  ),
  topCats: db.prepare(
    `SELECT category, type, SUM(amount) AS total, COUNT(*) AS n
     FROM transactions WHERE household_id = ? AND type = ? AND date BETWEEN ? AND ?
     GROUP BY category ORDER BY total DESC`
  ),
  dailySeries: db.prepare(
    `SELECT date,
            COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
     FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?
     GROUP BY date ORDER BY date`
  ),
  distinctDays: db.prepare(
    'SELECT DISTINCT date FROM transactions WHERE household_id = ? ORDER BY date DESC LIMIT ?'
  ),

  insertMsg: db.prepare(
    'INSERT INTO messages (id, household_id, user_id, role, text, payload) VALUES (?,?,?,?,?,?)'
  ),
  lastMessages: db.prepare(
    'SELECT * FROM messages WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  ),
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.display_name || u.email.split('@')[0] };
}

function createUser({ email, password, name, householdName, joinCode }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) throw new Error('Email tidak valid');
  if (!password || String(password).length < 6) throw new Error('Password minimal 6 karakter');
  if (S.getUserByEmail.get(clean)) throw new Error('Email sudah terdaftar');

  const id = uuid();
  S.insertUser.run(id, clean, hashPassword(password), name || clean.split('@')[0]);

  let household;
  if (joinCode) {
    household = S.householdByCode.get(String(joinCode).trim().toUpperCase());
    if (!household) throw new Error('Kode undangan tidak ditemukan');
    S.addMember.run(household.id, id, 'member');
  } else {
    household = createHousehold(householdName || 'Rumah Tangga', id);
  }
  return { user: publicUser(S.getUserById.get(id)), household };
}

function createHousehold(name, ownerId) {
  let code = makeCode();
  while (S.householdByCode.get(code)) code = makeCode();
  const id = uuid();
  S.insertHousehold.run(id, name, code);
  if (ownerId) S.addMember.run(id, ownerId, 'owner');
  return S.householdById.get(id);
}

function login({ email, password }) {
  const u = S.getUserByEmail.get(String(email || '').trim().toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) throw new Error('Email atau password salah');
  return publicUser(u);
}

function getUserById(_t, id) {
  const u = S.getUserById.get(id);
  return publicUser(u);
}

function getHousehold(_t, id) {
  return S.householdById.get(id) || null;
}

function listHouseholds(_accessToken, userId) {
  return S.listMemberships.all(userId)
    .map((m) => S.householdById.get(m.household_id))
    .filter(Boolean);
}

async function updateTransactionAsync(_t, householdId, id, patch) {
  return updateTransaction(_t, householdId, id, patch);
}

function getMembership(_accessToken, userId, householdId) {
  const m = S.listMemberships.all(userId).find((x) => x.household_id === householdId);
  if (!m) throw new Error('Akses ditolak');
  return m;
}

function listMembers(_t, householdId) {
  return S.listMembers.all(householdId).map((m) => ({
    id: m.id, email: m.email, name: m.display_name || m.email.split('@')[0], role: m.role,
  }));
}

const txRow = (t) => ({
  id: t.id, type: t.type, amount: Number(t.amount), category: t.category, note: t.note,
  raw: t.raw, date: t.date, authorId: t.user_id, author: t.author || null, createdAt: t.created_at,
});

function insertTransaction(_t, householdId, userId, tx) {
  const id = uuid();
  S.insertTx.run(id, householdId, userId || null, tx.type, Math.round(tx.amount), tx.category, tx.note, tx.raw || null, tx.date);
  return txRow(S.txById.get(householdId, id));
}

function listTransactions(_t, householdId, limit) {
  const rows = limit ? S.allTx.all(householdId).slice(0, limit) : S.allTx.all(householdId);
  return rows.map(txRow);
}

function getTransaction(_t, householdId, id) {
  const t = S.txById.get(householdId, id);
  return t ? txRow(t) : null;
}

function updateTransaction(_t, householdId, id, patch) {
  const cur = S.txById.get(householdId, id);
  if (!cur) return null;
  S.updateTx.run(
    patch.type || cur.type,
    patch.amount != null ? Math.round(patch.amount) : cur.amount,
    patch.category != null ? patch.category : cur.category,
    patch.note != null ? patch.note : cur.note,
    patch.date || cur.date,
    householdId, id
  );
  return txRow(S.txById.get(householdId, id));
}

function deleteTransaction(_t, householdId, id) {
  return S.deleteTx.run(householdId, id).changes > 0;
}

function deleteLastTransaction(_t, householdId) {
  const t = S.lastTx.get(householdId);
  if (!t) return null;
  S.deleteTx.run(householdId, t.id);
  return txRow(t);
}

function deleteAllTransactions(_t, householdId) {
  return S.deleteAllTx.run(householdId).changes;
}

function totals(_t, householdId) {
  const r = S.sumAll.get(householdId);
  return { income: Number(r.income), expense: Number(r.expense), balance: Number(r.income) - Number(r.expense), count: Number(r.n) };
}

function periodTotals(_t, householdId, from, to) {
  const r = S.sumRange.get(householdId, from, to);
  return { income: Number(r.income), expense: Number(r.expense), net: Number(r.income) - Number(r.expense), count: Number(r.n) };
}

function previousPeriodTotals(_t, householdId, from, to) {
  if (from < '2000-01-01') {
    return { income: 0, expense: 0, count: 0, from: null, to: null, available: false };
  }
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to + 'T00:00:00');
  const span = Math.round((t - f) / 86400000) + 1;
  const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - span + 1);
  const p = (d) => d.toISOString().slice(0, 10);
  const r = S.prevRange.get(householdId, p(prevFrom), p(prevTo));
  return { income: Number(r.income), expense: Number(r.expense), count: Number(r.n), from: p(prevFrom), to: p(prevTo), available: true };
}

function topCategories(_t, householdId, type, from, to) {
  return S.topCats.all(householdId, type, from, to)
    .map((r) => ({ category: r.category, type: r.type, total: Number(r.total), count: Number(r.n) }));
}

function dailySeries(_t, householdId, from, to) {
  return S.dailySeries.all(householdId, from, to)
    .map((r) => ({ date: r.date, income: Number(r.income), expense: Number(r.expense) }));
}

function activeDays(_t, householdId, limit = 30) {
  return S.distinctDays.all(householdId, limit).map((r) => r.date);
}

function insertMessage(_t, householdId, userId, role, text, payload) {
  const id = uuid();
  S.insertMsg.run(id, householdId, userId || null, role, text, payload ? JSON.stringify(payload) : null);
  return { id };
}

function lastMessages(_t, householdId, limit = 50) {
  return S.lastMessages.all(householdId, limit).reverse().map((m) => ({
    id: m.id, role: m.role, text: m.text,
    payload: m.payload ? JSON.parse(m.payload) : null,
    createdAt: m.created_at,
  }));
}

module.exports = {
  BACKEND: 'sqlite',
  createUser, login, createHousehold, listHouseholds, getMembership, listMembers,
  getUserById, getHousehold, updateTransaction: updateTransactionAsync,
  insertTransaction, listTransactions, getTransaction, deleteTransaction,
  deleteLastTransaction, deleteAllTransactions, totals, periodTotals,
  previousPeriodTotals, topCategories, dailySeries, activeDays,
  insertMessage, lastMessages,
};
