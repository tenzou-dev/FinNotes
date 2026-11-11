'use strict';

/**
 * Sesi login disimpan sebagai { token, expiresAt } di localStorage.
 * Token dipakai sebagai Bearer untuk semua /api/* — tidak ada cookie
 * dan tidak ada refresh token (sesi TTL 30 hari, buat ulang lewat login).
 */

const TOKEN_KEY = 'kj_session';

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (!s || typeof s.token !== 'string') {
      // format lama (era Supabase: {access_token, refresh_token}) dibuang
      if (s) localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    if (Number.isFinite(s.expiresAt) && Date.now() > s.expiresAt) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token: s.token,
    expiresAt: Number.isFinite(s.expiresAt) ? s.expiresAt : Date.now() + 30 * 24 * 3600e3,
  }));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
}

let config = null;

export async function initAuth() {
  config = await fetch('/api/config').then((r) => r.json());
  return { config };
}

export const getConfig = () => config;

export async function apiFetch(url, init = {}) {
  const s = getSession();
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  return fetch(url, { ...init, headers });
}

export async function apiJson(url, init) {
  const res = await apiFetch(url, init);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}
