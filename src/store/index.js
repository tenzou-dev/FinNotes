'use strict';

/**
 * Entry store untuk runtime Node (server lokal + e2e test).
 *
 * Store-nya sama persis dengan Worker produksi (src/store/d1.js); hanya
 * binding "D1" digantikan adapter node:sqlite. Schema, hash password,
 * dan perilaku query identik antara lokal dan produksi.
 *
 * File DB dipilih lewat env SQLITE_FILE:
 *   - default    : data/finnotes.db (dibuat otomatis kalau belum ada)
 *   - ':memory:' : DB in-memory, untuk test (selalu mulai kosong)
 *
 * Catatan: file ini TIDAK BOLEH ikut ter-bundle ke Worker
 * (dijaga oleh deploy/check-worker-deps.mjs).
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('./d1');
const { openD1 } = require('./node-d1');

const FILE = process.env.SQLITE_FILE || path.join(__dirname, '..', '..', 'data', 'finnotes.db');
if (FILE !== ':memory:') fs.mkdirSync(path.dirname(FILE), { recursive: true });

store.configure({
  db: openD1(FILE),
  iterations: Number(process.env.PBKDF2_ITERATIONS) || undefined,
});

module.exports = store;
