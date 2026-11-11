'use strict';

/**
 * Adapter node:sqlite -> antarmuka ala binding D1 Cloudflare.
 *
 * Cukup subset yang dipakai src/store/d1.js:
 *   db.exec(sql)
 *   db.prepare(sql).bind(...args).first() / .all() / .run()
 * dengan bentuk hasil dinormalisasi sama seperti D1
 * (.first() -> row|null, .all() -> {results}, .run() -> {meta.changes}).
 *
 * Hanya untuk runtime Node (server lokal + test). File ini TIDAK BOLEH
 * ikut ter-bundle ke Worker -- deploy/check-worker-deps.mjs menjaganya.
 */

const { DatabaseSync } = require('node:sqlite');

function openD1(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  function bound(stmt, params) {
    return {
      async first() {
        const row = stmt.get(...params);
        return row === undefined ? null : row;
      },
      async all() {
        const rows = stmt.all(...params);
        return { results: rows.map((r) => (r === undefined ? null : r)), success: true, meta: {} };
      },
      async run() {
        const r = stmt.run(...params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
  }

  return {
    file,
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return { bind: (...params) => bound(stmt, params) };
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openD1 };
