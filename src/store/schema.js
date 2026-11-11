'use strict';

/**
 * Satu sumber kebenaran schema database FinNotes.
 *
 * Dipakai di tiga tempat dengan hasil identik:
 *  - Worker produksi: binding D1 Cloudflare (self-apply saat boot, idempotent)
 *  - Server lokal / e2e: adapter node:sqlite (src/store/node-d1.js)
 *  - Test worker: node:sqlite ':memory:'
 *
 * Bentuknya array statement (bukan satu string multi-statement) supaya
 * tiap statement bisa dijalankan lewat exec() satu-per-satu tanpa
 * bergantung pada dukungan multi-statement, dan tidak pecah kalau kelak
 * ada SQL yang memuat ';' di dalam string.
 *
 * Catatan desain:
 *  - password_hash NULLable -> user yang lahir lewat Google tidak punya password
 *  - google_sub UNIQUE      -> satu akun Google = satu user; NULL untuk user password
 *  - sessions               -> session opaque sendiri (token hex), pengganti JWT Supabase
 */

module.exports = {
  SCHEMA_VERSION: 1,
  SCHEMA_STATEMENTS: [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      currency TEXT NOT NULL DEFAULT 'IDR',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS household_members (
      household_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (household_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_member_user ON household_members (user_id)`,

    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL,
      user_id TEXT,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      raw TEXT,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_h ON transactions (household_id, date DESC)`,

    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_msg_h ON messages (household_id, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_user ON sessions (user_id)`,
  ],
};
