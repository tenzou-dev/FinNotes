# FinNotes – Deploy Cloudflare Workers + D1

Folder ini berisi konfigurasi untuk menjalankan FinNotes sebagai **Cloudflare
Worker + Static Assets + D1** — satu ekosistem Cloudflare, tanpa layanan pihak
ketiga. Worker menjalankan API, file statis `public/` disajikan binding
`ASSETS`, dan seluruh data disimpan di D1 (SQLite).

Hasil deploy live: **<https://finnotes.tenzou.dev>** (custom domain di zone
`tenzou.dev`, dipasang via Worker Settings → Domains & Routes → Add → Custom
Domain; DNS record dan sertifikat dibuat otomatis Cloudflare). Setiap push ke
`main` di-deploy otomatis oleh Workers Builds; alternatif URL:
<https://finnotes.tenzou-dev.workers.dev>.

## 1. Buat database D1

Dashboard Cloudflare → **Storage & Databases → D1 SQL Database → Create
database** → beri nama `finnotes` → salin **Database ID**.

Atau via CLI:

```bash
npx wrangler d1 create finnotes
```

> Tidak ada migrasi manual. `src/store/schema.js` (ter-bundle ke Worker)
> meng-apply DDL sendiri saat request pertama — idempotent, aman diulang
> (dicek lewat `sqlite_master`).

## 2. Isi wrangler.toml

```toml
[[d1_databases]]
binding = "DB"
database_name = "finnotes"
database_id = "<Database ID dari langkah 1>"

[vars]
PBKDF2_ITERATIONS = "10000"
# GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com"
```

`GOOGLE_CLIENT_ID` bukan secret (Client ID OAuth memang publik dan muncul di
halaman login), jadi aman ditulis di `[vars]`. Buka tanda komentarnya lalu isi
untuk mengaktifkan tombol Google — authorized JavaScript origins di Google
Cloud Console harus memuat domain produksi.

## 3. Install & verifikasi

```bash
cd deploy
npm ci
npm run check      # bundle Worker tidak menarik API Node
npm test           # 112 test e2e Worker (store D1 :memory:)
npm run test:dry   # dry-run wrangler + static assets
```

Hasil dry-run yang benar: binding `env.DB (finnotes)` + `env.ASSETS` +
`env.PBKDF2_ITERATIONS`, total upload ~110 KiB (gzip ~26 KiB), tanpa error
`node:sqlite`/`fs`/`path`.

## 4. Dev lokal

```bash
npm run dev   # wrangler dev; D1 lokal otomatis dari binding
```

`wrangler dev` otomatis memakai salinan D1 lokal (`.wrangler/state`). Untuk
`GOOGLE_CLIENT_ID` lokal, salin `.dev.vars.example` → `.dev.vars` lalu isi.

Alternatif lain: server Express di root (`npm start`) — store & schema yang
sama persis, lewat adapter `node:sqlite`.

## 5. Deploy

```bash
npm run deploy
npm run tail       # lihat log produksi
```

Custom domain: Worker Settings → Domains & Routes → Add → Custom Domain.

Auto-deploy dari GitHub: hubungkan repo ke **Workers Builds** (dashboard
Worker → Settings → Builds), production branch `main`. Setelah itu `npm run
deploy` tidak perlu lagi — cukup push.

## 6. Verifikasi pasca-deploy

```bash
npm run test:live    # alur produksi nyata: signup, join, chat, export, logout
npm run verify:live  # cek aset, meta tag, /api/config
```

Keduanya memakai `WORKER_URL` (default `https://finnotes.tenzou.dev`).

## 7. Arsitektur penting

- **Satu store, dua runtime**: `src/store/d1.js` dipakai Worker (binding
  `env.DB`) dan server lokal (adapter `src/store/node-d1.js` di atas
  `node:sqlite`). Schema juga satu: `src/store/schema.js`.
- **Boot async**: `worker.fetch` wajib `await boot(env)` (lihat
  `deploy/src/runtime.js`). Boot meng-configure store dan apply schema
  (idempotent); hanya diulang saat instance `env.DB` berubah.
- **Auth**: bearer token di tabel `sessions`, TTL 30 hari, tanpa refresh token.
  Logout menghapus baris sesi — token langsung mati. Password PBKDF2-SHA256;
  jumlah iterasi tersimpan di tiap hash sehingga `PBKDF2_ITERATIONS` bisa
  dinaikkan kapan saja tanpa memutus user lama.
- **Signup transaksional**: kode undangan salah → 400 **sebelum** akun dibuat.
- **Google Sign-In**: tombol GIS di frontend → credential (ID token JWT) →
  `POST /api/auth/google` → server memverifikasi tanda tangan via JWKS Google
  (RS256/ES256, WebCrypto; cache 1 jam + refetch paksa saat rotasi `kid`) →
  akun/sesi dibuat server-side. Email yang sudah terdaftar otomatis ter-link.
- **Aset statis**: `[assets]` + `run_worker_first = true` — Worker dieksekusi
  lebih dulu lalu meneruskan request non-`/api/` ke `env.ASSETS`.
- **Modul CJS**: `src/*.js` masih CommonJS; esbuild Wrangler membungkusnya
  jadi default export (lihat `deploy/src/runtime.js`).
  `src/store/index.js` dan `src/store/node-d1.js` sengaja diblok dari bundle
  (dijaga `check-worker-deps.mjs`).

## 8. Troubleshooting

| Masalah | Penyebab | Solusi |
|---|---|---|
| `Binding D1 (env.DB) belum diset di wrangler.toml` | `[[d1_databases]]` tidak ada / salah nama binding | Isi binding `DB` + `database_id` yang benar. |
| 500 menyebut D1 saat request pertama | `database_id` salah atau DB belum dibuat | Cocokkan ID di dashboard D1. |
| Tombol Google tidak muncul | `GOOGLE_CLIENT_ID` kosong di `[vars]` | Isi lalu deploy ulang. |
| `Login Google belum dikonfigurasi di server ini` | sama | sama. |
| `Token Google gagal diverifikasi` | kid baru/JWKS tidak terambil | Refetch otomatis dijalankan sekali; coba lagi / cek egress. |
| Signup `kode undangan tidak ditemukan` | kode salah atau basi | Perilaku benar: akun tidak jadi dibuat. |
| `wrangler dev` kehilangan data lama | D1 lokal disimpan di `.wrangler/state` | Gunakan DB produksi hanya lewat deploy, bukan `wrangler dev`. |

## Catatan

- Jangan commit `.env`, `.dev.vars`, atau kredensial. Gunakan `.env.example`
  dan `.dev.vars.example`.
- Setelah deploy, coba signup dua user (satu join pakai kode undangan) untuk
  memastikan isolasi household.
