'use strict';

import { initAuth, getSession, saveSession, apiJson, getConfig } from './api.js';

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

// alphabet kode undangan: A-Z tanpa O/I + 2-9 (tanpa 0/1)
$('#fCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
});

function fail(msg) {
  err.textContent = msg;
  err.hidden = false;
  btn.disabled = false;
  btn.textContent = mode === 'login' ? 'Masuk' : 'Buat Akun';
}

/** Semua mode sekarang bearer token; server selalu mengembalikan token. */
function saveAuthSession(j) {
  if (!j.token) throw new Error('Login berhasil tapi token tidak diterima');
  saveSession({ token: j.token, expiresAt: j.expiresAt });
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
    // Signup & login selalu lewat server: password di-hash dan kode
    // undangan dicek di server SEBELUM akun dibuat (kode salah = 400).
    if (mode === 'login') {
      const j = await apiJson('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      saveAuthSession(j);
    } else {
      if (!payload.name) throw new Error('Nama belum diisi');
      const j = await apiJson('/api/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
      saveAuthSession(j);
    }
    location.href = './';
  } catch (error) {
    fail(error.message);
  }
};

/* ---------------- Google Sign-In (GIS) ---------------- */

/**
 * Tombol "Lanjut dengan Google" dari Google Identity Services.
 * Google menyerahkan credential (ID token JWT) langsung ke callback di
 * browser; kita POST ke /api/auth/google supaya server yang memverifikasi
 * tanda tangannya (JWKS) lalu membuat akun + sesi.
 */
async function initGoogle(config) {
  const slot = $('#googleSlot');
  if (!config.googleClientId) return; // belum dikonfigurasi -> tombol tetap hidden

  slot.hidden = false;
  $('#authAlt').hidden = false;
  try {
    await new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('gagal memuat'));
      document.head.appendChild(s);
    });
    const gsi = window.google?.accounts?.id;
    if (!gsi) throw new Error('pustaka tidak tersedia');

    gsi.initialize({
      client_id: config.googleClientId,
      callback: async (resp) => {
        try {
          const j = await apiJson('/api/auth/google', {
            method: 'POST',
            body: JSON.stringify({ credential: resp.credential }),
          });
          saveAuthSession(j);
          location.href = './';
        } catch (e) {
          fail(e.message);
        }
      },
    });
    // renderButton perlu container terlihat (clientWidth > 0) — slot
    // sudah di-unhide di atas.
    gsi.renderButton(slot, {
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      locale: 'id',
      width: Math.max(200, slot.clientWidth || 300),
    });
  } catch (e) {
    fail('Login Google tidak bisa dimuat: ' + e.message);
    slot.hidden = true;
    $('#authAlt').hidden = true;
  }
}

(async () => {
  try {
    const { config } = await initAuth();
    ready = true;
    $('#authHint').textContent = config.local
      ? 'Mode lokal — data tersimpan di file SQLite komputer ini.'
      : 'Akun & data disimpan di Cloudflare D1.';
    if (getSession()) {
      location.href = './';
      return;
    }
    await initGoogle(config);
  } catch (e) {
    ready = true;
    $('#authHint').textContent = 'Gagal cek konfigurasi: ' + e.message;
  }
})();
