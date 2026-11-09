# Kasir Chat

Pencatatan keuangan lewat chat bahasa Indonesia. Ketik seperti ngobrol,
aplikasinya yang mem-parse, membuat transaksi, menghitung saldo, dan menyimpan
riwayat.

Multi-user: dua akun (misalnya kamu dan istri) melihat **buku keuangan yang sama**.

## Fitur

- Parser bahasa Indonesia tanpa API eksternal: `gaji 8jt`, `beli nasi 25rb sama kopi 15rb`
- Multi-transaksi per pesan, format `1,2jt` dan `1.000.000` aman
- Multi-user dengan satu household bersama, pendaftaran lewat **kode undangan**
- Grafik: donat kategori, batang harian, perbandingan periode
- Export CSV (transaksi dan rekap) plus backup JSON
- Edit dan hapus transaksi dari UI
- Row Level Security di Supabase: user hanya bisa melihat household sendiri

## Kebutuhan

- Node.js **>= 22.5** (memakai modul bawaan `node:sqlite`)
- Supabase project (opsional, hanya untuk mode cloud)

## Menjalankan cepat (mode lokal, tanpa Supabase)

Tidak perlu konfigurasi apa pun. Otomatis memakai SQLite lokal.

```bash
npm install
npm start
```

Buka <http://localhost:3000>, lalu daftar akun pertama.

## Setup Supabase (mode cloud)

### 1. Buat schema

Supabase Dashboard -> **SQL Editor** -> New query -> salin seluruh isi
[`supabase/schema.sql`](supabase/schema.sql) -> Run.

Tabel yang dibuat:

| Tabel | Isi |
| --- | --- |
| `households` | buku bersama, punya `join_code` |
| `profiles` | nama dan email user, dibuat otomatis saat signup |
| `household_members` | user ke household, role `owner` / `member` |
| `transactions` | semua transaksi |
| `messages` | riwayat chat |

Plus RLS policy, trigger profile, dan dua RPC: `setup_my_household` serta
`join_household`.

> Eksekusi ulang script aman: semuanya memakai `if not exists` dan `or replace`.

### 2. Isi environment variables

Salin `.env.example` jadi `.env`, lalu isi:

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
```

- Ambil **URL** dan **anon / publishable key** dari Dashboard -> Project Settings -> API
- **Jangan pernah** memakai `service_role` key, key itu melewati RLS

`.env` sudah masuk `.gitignore` dan dimuat otomatis saat start.

### 3. Matikan konfirmasi email (WAJIB untuk app ini)

Supabase Dashboard -> **Authentication** -> **Sign In / Providers** -> **Email**, matikan
**Confirm email**.

Kalau nyalakan, tiap signup mengirim email sungguhan dan kena **email rate limit** Supabase
free tier (sekitar 2-4 signup per jam). Gejalanya user melihat
`{"error":"email rate limit exceeded"}` dan tidak bisa daftar sama sekali.

Verifikasi lewat Worker (butuh login):

```bash
curl -X POST https://kasir-chat.badminton-iiknu.workers.dev/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"tes@gmail.com","password":"rahasia123456","name":"Tes","householdName":"Tes"}'
```

Kalau dapat `email rate limit exceeded`, opsi lain: naikkan **Email Rate Limit** di
Authentication -> Sign In / Providers -> Email.

### 4. Jalankan

```bash
npm start
```

### 5. Ajak orang lain

1. Daftar akun pertama, isi nama buku, misalnya `Rumah`
2. Menu **Anggota** di aplikasi -> salin **kode undangan**
3. Orang kedua mendaftar dengan kode tersebut -> langsung masuk ke buku yang sama

## Testing

```bash
npm test          # parser + splitter
npm run test:all  # tambah e2e (butuh server jalan)
```

E2E membutuhkan server aktif:

```bash
$env:PORT=3312; node server.js
node test/e2e.test.js
```

Yang diuji: signup, dua user satu household, isolasi antar household, chat
multi-transaksi, analytics semua periode, export, edit, hapus, dan login ulang.

Suite Worker (mock Supabase, tanpa jaringan):

```bash
npm run test:worker  # 89 test
npm run check:worker # pastikan bundle tidak pull API Node
```

## Deploy ke Cloudflare Workers

```bash
# 1. isi SUPABASE_URL di deploy/wrangler.toml
# 2. install dependency deploy
npm --prefix deploy ci

# 3. pasang anon key sebagai secret
npm --prefix deploy exec -- wrangler secret put SUPABASE_ANON_KEY

# 4. deploy
npm --prefix deploy run deploy
```

Instruksi lengkap: `deploy/README.md`.

## Konfigurasi

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `SUPABASE_URL` | - | URL project Supabase |
| `SUPABASE_ANON_KEY` | - | anon / publishable key |
| `STORE_BACKEND` | auto | `supabase` atau `sqlite` untuk memaksa |
| `PORT` | `3000` | port HTTP |

Kalau `SUPABASE_URL` dan `SUPABASE_ANON_KEY` kosong, backend otomatis jatuh ke
SQLite lokal.

## Struktur

```
server.js               Express: auth, chat, state, analytics, export
src/parser.js           parse satu transaksi dari teks
src/splitter.js         pecah satu pesan jadi banyak transaksi
src/assistant.js        command dan orkestrasi chat
src/analytics.js        agregasi kategori, harian, perbandingan
src/csv.js              export CSV
src/store/index.js      pilih backend, kontrak argumen seragam
src/store/sqlite.js     implementasi lokal (node:sqlite)
src/store/supabase.js   implementasi cloud (PostgREST + Supabase Auth)
public/                 UI tanpa framework
supabase/schema.sql     schema, RLS, RPC
test/                   parser, splitter, e2e
```

## Catatan keamanan

- Semua query ke Supabase memakai token user, tidak ada `service_role`
- RLS menjaga user hanya bisa mengakses household yang dia menjadi anggota
- Cookie fallback SQLite **tidak ditandatangani**, mode itu hanya untuk pengembangan
- Gunakan password yang kuat, minimal 6 karakter
