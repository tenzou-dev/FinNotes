'use strict';

/**
 * Verifikasi Google ID token untuk tombol "Lanjut dengan Google" (GIS).
 *
 * Dipakai route /api/auth/google di worker maupun server lokal. Murni Web
 * API (atob, fetch, crypto.subtle) tanpa dependensi Node supaya bisa
 * ter-bundle ke Cloudflare Workers tanpa polyfill.
 *
 * Keputusan desain:
 *  - hanya RS256 & ES256 (algoritma kunci yang Google pakai saat ini)
 *  - JWKS di-cache 1 jam di scope modul; refetch paksa TEPAT SATU kali
 *    kalau kid tidak ketemu atau tanda tangan gagal (rotasi kunci Google)
 *  - klaim yang dicek: iss, aud, exp (leeway 60 dtk), sub, email_verified
 *  - fetchImpl bisa diganti lewat configure({fetch}) untuk test
 */

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_LEEWAY_S = 60;

let fetchImpl = (...args) => globalThis.fetch(...args);
let jwksCache = { keys: [], fetchedAt: 0 };

function configure({ fetch } = {}) {
  if (typeof fetch === 'function') fetchImpl = fetch;
}

/* ---------------- base64url & DER ---------------- */

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodeJsonSegment = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/* ---------------- JWKS ---------------- */

async function fetchJwks(force) {
  const fresh = Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (!force && jwksCache.keys.length && fresh) return jwksCache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error('Gagal mengambil kunci publik Google');
  const data = await res.json();
  // cache hanya ditimpa kalau fetch sukses
  jwksCache = { keys: Array.isArray(data.keys) ? data.keys : [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/* ---------------- verifikasi ---------------- */

async function importVerifyKey(jwk) {
  if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true, key_ops: ['verify'] },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  }
  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.x && jwk.y) {
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  }
  return null;
}

async function tryVerify(jwk, alg, data, sig) {
  try {
    const key = await importVerifyKey(jwk);
    if (!key) return false;
    // ES256: tanda tangan Google = raw r||s (format JWS) = format asli
    // WebCrypto untuk ECDSA, jadi tidak perlu konversi DER.
    const algorithm = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5';
    return await crypto.subtle.verify(algorithm, key, sig, data);
  } catch {
    return false;
  }
}

/**
 * Verifikasi ID token Google (JWT RS256/ES256) untuk clientId ini.
 * Return klaim yang dipakai aplikasi: { sub, email, name, picture }.
 * Semua kegagalan dilempar sebagai Error berpesan Indonesia.
 */
async function verifyGoogleIdToken(idToken, clientId) {
  if (!clientId) throw new Error('Login Google belum dikonfigurasi di server ini');
  const token = String(idToken || '').trim();
  if (!token) throw new Error('Token Google tidak diterima');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token Google tidak valid');

  let header;
  let payload;
  try {
    header = decodeJsonSegment(parts[0]);
    payload = decodeJsonSegment(parts[1]);
  } catch {
    throw new Error('Token Google tidak valid');
  }

  const alg = header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') throw new Error('Algoritma token Google tidak didukung');
  if (!header.kid) throw new Error('Token Google tanpa key id');

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Token bukan dari Google');
  }
  if (payload.aud !== clientId) throw new Error('Token bukan untuk aplikasi ini');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || Number(payload.exp) + CLOCK_LEEWAY_S < now) {
    throw new Error('Sesi Google sudah kedaluwarsa, coba lagi');
  }
  if (!payload.sub) throw new Error('Token Google tanpa identitas');
  if (payload.email && payload.email_verified === false) {
    throw new Error('Email Google belum terverifikasi');
  }

  const sig = b64urlToBytes(parts[2]);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  let keys = await fetchJwks(false);
  let jwk = keys.find((k) => k && k.kid === header.kid) || null;
  let verified = jwk ? await tryVerify(jwk, alg, data, sig) : false;
  if (!verified) {
    // kid baru / rotasi kunci: paksa ambil JWKS segar sekali ini saja
    keys = await fetchJwks(true);
    jwk = keys.find((k) => k && k.kid === header.kid) || null;
    verified = jwk ? await tryVerify(jwk, alg, data, sig) : false;
  }
  if (!verified) throw new Error('Token Google gagal diverifikasi');

  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email).trim().toLowerCase() : null,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}

module.exports = { verifyGoogleIdToken, configure };
