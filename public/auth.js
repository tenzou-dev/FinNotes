'use strict';

import { initAuth, getSession, saveSession, apiJson, getSupa } from './api.js';

const $ = (s) => document.querySelector(s);
const form = $('#authForm');
const err = $('#authErr');
const btn = $('#authBtn');

let mode = 'login';
let ready = false;

function setMode(next) {
  mode = next;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === mode));
  document.querySelectorAll('[data-only="signup"]').forEach((el) => (el.hidden = mode !== 'signup'));
  err.hidden = true;
  btn.textContent = mode === 'login' ? 'Masuk' : 'Buat Akun';
  $('#fPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

document.querySelectorAll('.auth-tab').forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));

$('#fCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function fail(msg) {
  err.textContent = msg;
  err.hidden = false;
  btn.disabled = false;
  btn.textContent = mode === 'login' ? 'Masuk' : 'Buat Akun';
}

/**
 * Simpan sesi hasil auth.
 *
 * Backend Supabase memakai bearer token yang disimpan di localStorage, supaya
 * cookie sesi dari server diabaikan. Backend lokal (SQLite) memakai cookie
 * sesi HTTP-only, jadi `token`-nya memang null dan tidak ada yang perlu disimpan.
 */
function saveAuthSession(j, label) {
  const token = j.access_token || j.token;
  if (token) {
    saveSession({ access_token: token, refresh_token: j.refresh_token, expires_at: j.expires_at });
    return;
  }
  if (j.backend === 'supabase') {
    throw new Error(`${label} berhasil tapi token tidak diterima`);
  }
  // backend lokal: cookie sesi sudah disetel server
}

form.onsubmit = async (e) => {
  e.preventDefault();
  if (!ready) return fail('Tunggu sebentar, masih memuat...');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = mode === 'login' ? 'Memproses...' : 'Membuat...';

  const payload = {
    email: $('#fEmail').value.trim(),
    password: $('#fPass').value,
    name: $('#fName').value.trim(),
    householdName: $('#fHouse').value.trim() || 'Rumah Tangga',
    joinCode: $('#fCode').value.trim().toUpperCase(),
  };

  try {
    // Signup & login selalu lewat server, baik di mode SQLite maupun Supabase.
    // Di mode Supabase, Worker-lah yang membuat household (atau menggabungkan
    // lewat kode undangan) lewat RPC. Kalau klien menDAFTAR langsung ke
    // Supabase Auth, tidak ada household yang terbentuk dan user akan terjebak
    // di aplikasi tanpa buku.
    if (mode === 'login') {
      const j = await apiJson('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      saveAuthSession(j, 'Login');
    } else {
      if (!payload.name) throw new Error('Nama belum diisi');
      const j = await apiJson('/api/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
      saveAuthSession(j, 'Signup');
      // Akun sudah dibuat tapi kode undangan ditolak, jadi server membuat
      // household cadangan. Beri tahu user, jangan dibiarkan diam-diam.
      if (j.warning) sessionStorage.setItem('kj_signup_warning', j.warning);
    }
    location.href = './';
  } catch (error) {
    fail(error.message);
  }
};

/* ---------------- Google OAuth ---------------- */

const btnGoogle = $('#btnGoogle');
const btnGoogleLabel = $('#btnGoogleLabel');

function startGoogle() {
  const supa = getSupa();
  if (!supa) return fail('Login Google hanya tersedia di mode online');
  btnGoogle.disabled = true;
  btnGoogleLabel.textContent = 'Mengalihkan ke Google...';
  const redirectTo = new URL('login.html', location.href).href;
  location.href = supa.oauthUrl('google', redirectTo);
}

/**
 * Deteksi balikan OAuth: Supabase mengarahkan kembali ke halaman ini dengan
 * token di URL hash (#access_token=...&refresh_token=...). Kirim token ke
 * Worker supaya profile + household dibuat server-side, lalu masuk app.
 * Return true kalau hash berisi hasil OAuth (sukses maupun error).
 */
async function handleOAuthReturn() {
  const p = new URLSearchParams(location.hash.slice(1));
  const accessToken = p.get('access_token');
  const oauthError = p.get('error_description') || p.get('error');
  if (!accessToken && !oauthError) return false;

  history.replaceState(null, '', location.pathname + location.search);
  if (!accessToken) {
    fail(oauthError || 'Login Google dibatalkan');
    return true;
  }

  btnGoogle.disabled = true;
  btnGoogleLabel.textContent = 'Menyelesaikan login...';
  const expiresIn = Number(p.get('expires_in') || 3600);
  try {
    const j = await apiJson('/api/auth/google', {
      method: 'POST',
      retry: false,
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        refresh_token: p.get('refresh_token'),
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      }),
    });
    saveAuthSession(j, 'Login Google');
    location.href = './';
  } catch (e) {
    fail(e.message);
    btnGoogle.disabled = false;
    btnGoogleLabel.textContent = 'Lanjutkan dengan Google';
  }
  return true;
}

btnGoogle.onclick = startGoogle;

(async () => {
  try {
    const { config } = await initAuth();
    ready = true;
    if (config.backend === 'supabase') {
      $('#authHint').textContent = 'Akun & data disimpan di Supabase.';
      btnGoogle.hidden = false;
      $('#authAlt').hidden = false;
    } else {
      $('#authHint').textContent = 'Mode lokal (SQLite). Set SUPABASE_URL + SUPABASE_ANON_KEY untuk pindah ke Supabase.';
    }
    const oauthHandled = await handleOAuthReturn();
    if (!oauthHandled && getSession()) location.href = './';
  } catch (e) {
    ready = true;
    $('#authHint').textContent = 'Gagal cek konfigurasi: ' + e.message;
  }
})();
