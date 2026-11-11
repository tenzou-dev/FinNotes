/**
 * Konfigurasi runtime untuk Cloudflare Worker: binding D1.
 *
 * Binding DB dan vars ada di wrangler.toml ([[d1_databases]], [vars]).
 * Schema di-apply sendiri oleh store saat boot (idempotent), jadi tidak
 * perlu migrasi manual di dashboard.
 */

// Modul bersama sengaja masih CommonJS; esbuild membungkusnya jadi default export.
import d1 from '../../src/store/d1.js';
import parser from '../../src/parser.js';
import meta from '../../src/meta.js';

const { EXAMPLES, INCOME, EXPENSE } = parser;
const { CATEGORIES } = meta;

let configuredDb = null;
let bootPromise = null;

/**
 * Pasang store ke binding D1. Async karena apply schema di-await di sini;
 * worker.fetch WAJIB `await boot(env)` sebelum melayani request.
 *
 * env Worker konstan selama satu deploy, jadi configure hanya diulang saat
 * instance DB berubah (test memakai DB :memory: berbeda per file).
 */
export async function boot(env) {
  if (!env || !env.DB) {
    throw new Error('Binding D1 (env.DB) belum diset di wrangler.toml');
  }
  if (configuredDb !== env.DB) {
    bootPromise = d1.configure({
      db: env.DB,
      iterations: Number(env.PBKDF2_ITERATIONS) || undefined,
    });
    configuredDb = env.DB;
  }
  await bootPromise;
}

/**
 * Store untuk ctx.store. Kontrak argumen seragam (accessToken lebih dulu),
 * sama dengan yang dipakai assistant.js dan analytics.js.
 */
export function getStore() {
  return d1;
}

export { EXAMPLES, INCOME, EXPENSE, CATEGORIES };
