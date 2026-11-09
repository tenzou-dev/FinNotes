'use strict';

const fs = require('fs');
const path = require('path');

// muat .env kalau ada (Node >= 20.12), env yang sudah diset tetap menang
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // abaikan, biarkan detectBackend pakai process.env
}

const SUPA_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function detectBackend() {
  const forced = (process.env.STORE_BACKEND || '').toLowerCase();
  if (forced === 'sqlite') return 'sqlite';
  if (forced === 'supabase') return 'supabase';
  return SUPA_URL && ANON_KEY ? 'supabase' : 'sqlite';
}

function requireSupabaseEnv() {
  if (!SUPA_URL || !ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY belum di-set');
  }
  return { SUPA_URL, ANON_KEY };
}

module.exports = { detectBackend, requireSupabaseEnv, SUPA_URL, ANON_KEY };
