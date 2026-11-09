'use strict';

// Mini client Supabase Auth via REST (tanpa SDK / tanpa bundler).
// Hanya bagian yang dipakai: signup, login, refresh, getUser.

export function createSupabaseLite(url, anonKey) {
  const base = `${url.replace(/\/$/, '')}/auth/v1`;
  const headers = (extra = {}) => ({
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  function mapError(message) {
    if (/invalid login credentials/i.test(message)) return 'Email atau password salah';
    if (/already registered|already been registered/i.test(message)) return 'Email sudah terdaftar';
    if (/password should be at least/i.test(message)) return 'Password minimal 6 karakter';
    if (/email not confirmed/i.test(message)) return 'Email belum dikonfirmasi, cek inbox dulu';
    if (/rate limit|too many/i.test(message)) return 'Terlalu banyak percobaan, coba lagi nanti';
    return message;
  }

  async function call(path, init = {}) {
    const res = await fetch(base + path, { ...init, headers: headers(init.headers) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const raw = data?.error_description || data?.msg || data?.error || res.statusText;
      throw new Error(mapError(String(raw)));
    }
    return data;
  }

  return {
    url,
    anonKey,

    async signUp(email, password, meta) {
      const d = await call('/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, data: meta || {} }),
      });
      if (!d?.access_token) {
        throw new Error('Akun dibuat. Konfirmasi email dulu, lalu masuk.');
      }
      return d;
    },

    async signIn(email, password) {
      const d = await call('/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      return d;
    },

    async refresh(refreshToken) {
      const d = await call('/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      return d;
    },

    async getUser(accessToken) {
      const res = await fetch(`${base}/user`, {
        headers: headers({ Authorization: `Bearer ${accessToken}` }),
      });
      if (!res.ok) return null;
      return res.json();
    },
  };
}
