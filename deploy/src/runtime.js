/**
 * Konfigurasi runtime untuk Cloudflare Worker.
 *
 * Secret (SUPABASE_ANON_KEY) disimpan lewat `wrangler secret put`.
 * Non-secret (SUPABASE_URL) disimpan lewat [vars] di wrangler.toml.
 */

// Modul bersama sengaja masih CommonJS; esbuild membungkusnya jadi default export.
import supa from '../../src/store/supabase.js';
import parser from '../../src/parser.js';
import meta from '../../src/meta.js';

const { EXAMPLES, INCOME, EXPENSE } = parser;
const { CATEGORIES } = meta;

let configured = null;

export function boot(env) {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL atau SUPABASE_ANON_KEY belum diset di Worker');
  }
  // env Worker konstan selama satu deploy, jadi configure cukup saat berubah.
  if (!configured || configured.url !== url || configured.anonKey !== anonKey) {
    supa.configure({ url, anonKey });
    configured = { url, anonKey };
  }
}

/**
 * Store untuk ctx.store. Kontrak argumen seragam (accessToken lebih dulu),
 * sama dengan yang dipakai assistant.js dan analytics.js.
 */
export function getStore() {
  return supa;
}

export { EXAMPLES, INCOME, EXPENSE, CATEGORIES };
