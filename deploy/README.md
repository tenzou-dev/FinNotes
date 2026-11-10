# FinNotes – Deploy Cloudflare Workers + Supabase

Folder ini berisi konfigurasi untuk meng-deploy aplikasi FinNotes sebagai **Cloudflare Workers + Static Assets** (bukan Pages). Worker menjalankan API (Fetch API), sedangkan file statis dari `public/` disajikan oleh `ASSETS`.

## 1. Jalankan schema Supabase

1. Buka [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql).
2. Salin isi `../supabase/schema.sql` dan jalankan.
3. Pastikan RLS aktif, tabel `profiles`, `households`, `household_members`, `transactions`, `messages` terbuat, serta RPC `setup_my_household` dan `join_household` tersedia.

## 2. Dapatkan credential Supabase

Dari Project Settings → API:
- `Project URL` → pakai untuk `SUPABASE_URL`
- `anon public key` → pakai untuk `SUPABASE_ANON_KEY` (dipasang sebagai Worker Secret)

## 3. Konfigurasi Wrangler

Edit `wrangler.toml`, ganti `SUPABASE_URL` dengan URL project-mu:

```toml
[vars]
SUPABASE_URL = "https://GANTI-DENGAN-PROJECT-ID.supabase.co"
```

> `SUPABASE_ANON_KEY` **TIDAK** ditulis di `wrangler.toml`. Masukkan lewat secret.

## 4. Install & verifikasi

```bash
cd deploy
npm ci
npm run check   # pastikan bundle bersih (tanpa sqlite/node built-in)
npm test        # 89 test E2E Worker mock (harus hijau)
npm run test:dry # dry-run Wrangler + static assets
```

Untuk `npm run dev` lokal tanpa menyetel secret, salin `.dev.vars.example` menjadi `.dev.vars` lalu isi nilainya.

Hasil dry-run: baca 7 file asset, total upload ~1.0MB (gzip ~184KB). Tidak boleh ada error `node:sqlite`, `fs`, `path`, dll.

## 5. Pasang Secret & Deploy

```bash
# 1. Pasang anon key sebagai secret
npx wrangler secret put SUPABASE_ANON_KEY

# 2. Deploy ke production
npm run deploy

# 3. Cek log jika perlu
npm run tail
```

## 6. Arsitektur penting

- **Express + SQLite** hanya dipakai untuk development lokal (`npm start` di root). Worker **tidak** memuat `src/store/sqlite.js` atau `src/config.js`.
- **Satu jalur auth**: frontend selalu memanggil `/api/auth/signup` dan `/api/auth/login`. Di mode Supabase, Worker yang membuat/menggabungkan household lewat RPC (`security definer`). Ini menjamin user **selalu punya household** (kalau kode undangan ditolak, Worker membuat household cadangan dan mengembalikan `warning`). Jangan diubah kembali supaya klien mendaftar langsung ke Supabase Auth.
- **Token strategy**: Worker mode Supabase memakai **Bearer access_token** + `refresh_token` (dikembalikan di respons signup/login agar sesi bisa diperpanjang). Server lokal memakai **cookie session** sehingga `token: null` dan `backend: "sqlite"` — `saveAuthSession()` di `public/auth.js` yang membedakan keduanya.
- **RLS enforced**: semua request mengirim Bearer user, tidak ada `service_role`. Pastikan schema.sql ter-aplikasi.
- **Module CJS** di `src/*` dibungkus Wrangler (ESM worker). Adapter Supabase dikonfigurasi dari binding `env` di `deploy/src/runtime.js`.

## 7. Troubleshooting

| Masalah | Penyebab | Solusi |
|---|---|---|
| `SUPABASE_URL atau SUPABASE_ANON_KEY belum diset` | Secret/vars belum terpasang | Cek `wrangler.toml` (URL) dan `wrangler secret list`. |
| RPC `setup_my_household/join_household` gagal 403 | Function privileges/grant | Pastikan di SQL Editor grant EXECUTE ke `authenticated` (sudah ada di schema). |
| User terjebak tanpa household | UI signUp langsung ke Supabase Auth | Pastikan frontend memakai endpoint Worker (sudah diperbaiki). |
| `token: null` saat test manual | Itu benar untuk backend SQLite (cookie session) | Cek `backend` di respons. Kalau backend `supabase` dan `token` null, itu bug. |
| `DELETE` balas 405 | Router memilih route dengan pathname sama tapi method beda | `match()` di `deploy/src/router.js` sudah prioritise route method yang sama. |

## Catatan

- Jangan commit `.env`, `.dev.vars`, atau kredensial. Gunakan `.env.example` dan `.dev.vars.example`.
- Setelah deploy, buka `https://<worker>.workers.dev` dan coba signup dua user (satu join pakai kode, satu buat sendiri) untuk memastikan isolasi household.
