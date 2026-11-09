'use strict';

const TOKEN_KEY = 'kj_session';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSession(s) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || (Date.now() + 3600e3),
  }));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
}

let config = null;
let supa = null;

export async function initAuth() {
  config = await fetch('/api/config').then((r) => r.json());
  if (config.backend === 'supabase' && config.supabase?.url && config.supabase?.anonKey) {
    const { createSupabaseLite } = await import('./supa.js');
    supa = createSupabaseLite(config.supabase.url, config.supabase.anonKey);
  }
  return { config, supa };
}

export const getSupa = () => supa;
export const getConfig = () => config;

async function refreshSession() {
  const s = getSession();
  if (!s?.refresh_token || !supa) return null;
  const d = await supa.refresh(s.refresh_token);
  saveSession(d);
  return d.access_token;
}

let refreshing = null;

export async function apiFetch(url, { retry = true, ...init } = {}) {
  const s = getSession();
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (s?.access_token) headers.Authorization = `Bearer ${s.access_token}`;

  const res = await fetch(url, { ...init, headers });
  if (res.status !== 401 || !retry) return res;

  refreshing = refreshing || refreshSession().finally(() => { refreshing = null; });
  const fresh = await refreshing;
  if (!fresh) return res;

  return apiFetch(url, { ...init, retry: false, headers: { ...headers, Authorization: `Bearer ${fresh}` } });
}

export async function apiJson(url, init) {
  const res = await apiFetch(url, init);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}
