/**
 * E2E untuk Cloudflare Worker di atas store D1.
 *
 * Menjalankan worker.js sungguhan (modul ESM yang sama dengan yang
 * di-deploy) dengan binding DB tiruan (node:sqlite ':memory:' lewat
 * adapter ala D1) dan binding ASSETS tiruan. Yang ter-cover: routing
 * Worker, parsing body/param, store D1, dan seluruh alur bisnis.
 *
 * Login Google diuji sungguhan: ID token JWT ditandatangani WebCrypto
 * (RS256 & ES256), JWKS disajikan lewat stub globalThis.fetch, termasuk
 * skenario rotasi kunci.
 *
 * Jalankan: node deploy/test/worker.test.mjs
 */

import nodeD1 from '../../src/store/node-d1.js';
import worker from '../worker.js';

const { openD1 } = nodeD1;

/* ---------------- harness ---------------- */

let pass = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name + (extra ? ` :: ${extra}` : ''));
    console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

const section = (t) => console.log(`\n${t}`);

/* ---------------- env ---------------- */

const assets = {
  fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`, {
    headers: { 'Content-Type': 'text/plain' },
  }),
};

const GOOGLE_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';

const env = {
  DB: openD1(':memory:'),
  ASSETS: assets,
  GOOGLE_CLIENT_ID,
  PBKDF2_ITERATIONS: '1000', // supaya test cepat; produksi 10000
};

const APP_URL = 'https://app.test';

async function call(method, path, { token, body } = {}) {
  const req = new Request(APP_URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, {});
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, res };
}

/* ---------------- Google OIDC: kunci + stub JWKS ---------------- */

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeKey(alg, kid) {
  if (alg === 'ES256') {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    return { alg, kp, kid, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, use: 'sig', alg } };
  }
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true, ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { alg, kp, kid, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg } };
}

/** WebCrypto ECDSA menandatangani dalam bentuk raw r||s — persis format Google. */
async function signIdToken(key, payload) {
  const h = b64url(enc.encode(JSON.stringify({ alg: key.alg, kid: key.kid, typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(`${h}.${p}`);
  const alg = key.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5';
  const sig = await crypto.subtle.sign(alg, key.kp.privateKey, data);
  return `${h}.${p}.${b64url(sig)}`;
}

const googlePayload = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: GOOGLE_CLIENT_ID,
  sub: 'gsub-' + Math.random().toString(36).slice(2, 10),
  email: `g${Date.now()}.${Math.random().toString(36).slice(2, 8)}@gmail.com`,
  email_verified: true,
  name: 'Budi Google',
  picture: 'https://lh3.googleusercontent.com/a/x',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
  ...over,
});

const rsaKey = await makeKey('RS256', 'test-rsa');
const ecKey = await makeKey('ES256', 'test-ec');
let jwksKeys = [rsaKey.jwk, ecKey.jwk];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (String(url).startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    return new Response(JSON.stringify({ keys: jwksKeys }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, ...rest);
};

/* ---------------- tests ---------------- */

try {
  section('aset statis & routing');
  {
    const r = await worker.fetch(new Request('https://app.test/login.html'), env, {});
    ok('login.html dilayani ASSETS', (await r.text()) === 'asset:/login.html');
    const cfg = await call('GET', '/api/config');
    ok('api/config backend d1', cfg.data.backend === 'd1', JSON.stringify(cfg.data));
    ok('api/config local false', cfg.data.local === false, JSON.stringify(cfg.data));
    ok('api/config googleClientId', cfg.data.googleClientId === GOOGLE_CLIENT_ID, JSON.stringify(cfg.data));
    const nf = await call('GET', '/api/tidak-ada');
    ok('route tidak dikenal -> 404', nf.status === 404);
    const wrong = await call('DELETE', '/api/state');
    ok('method salah -> 405', wrong.status === 405);
    const opts = await worker.fetch(new Request('https://app.test/api/state', { method: 'OPTIONS' }), env, {});
    ok('OPTIONS preflight -> 204', opts.status === 204);
  }

  section('signup + household bersama');
  const stamp = Date.now();
  const emailA = `andi${stamp}@test.com`;
  const emailB = `siti${stamp}@test.com`;

  const suA = await call('POST', '/api/auth/signup', {
    body: { email: emailA, password: 'rahasia123', name: 'Andi', householdName: 'Rumah Andi' },
  });
  ok('signup Andi 200', suA.status === 200, JSON.stringify(suA.data).slice(0, 160));
  ok('signup mengembalikan token', !!suA.data.token);
  ok('signup mengembalikan expiresAt (ms)', Number.isFinite(suA.data.expiresAt) && suA.data.expiresAt > Date.now(), String(suA.data.expiresAt));
  ok('tanpa refresh_token', suA.data.refresh_token === undefined, String(suA.data.refresh_token));
  ok('signup membuat household', !!suA.data.household?.id && !!suA.data.household?.join_code, JSON.stringify(suA.data.household));
  ok('join_code format A-Z2-9 (tanpa 0/O/1/I)', /^[A-Z2-9]{6}$/.test(suA.data.household?.join_code || ''), suA.data.household?.join_code);
  let tokenA = suA.data.token;
  const houseId = suA.data.household.id;
  const joinCode = suA.data.household.join_code;

  const dupe = await call('POST', '/api/auth/signup', { body: { email: emailA, password: 'rahasia123', name: 'Dupe' } });
  ok('email duplikat ditolak', dupe.status === 400 && /sudah terdaftar/.test(dupe.data.error), JSON.stringify(dupe.data));

  const weak = await call('POST', '/api/auth/signup', { body: { email: `x${stamp}@t.com`, password: '123', name: 'X' } });
  ok('password lemah ditolak', weak.status === 400, JSON.stringify(weak.data));

  const suB = await call('POST', '/api/auth/signup', {
    body: { email: emailB, password: 'rahasia123', name: 'Siti', joinCode },
  });
  ok('signup Siti gabung via kode', suB.status === 200, JSON.stringify(suB.data).slice(0, 160));
  ok('Siti masuk household yang sama', suB.data.household?.id === houseId, `${suB.data.household?.id} vs ${houseId}`);
  const tokenB = suB.data.token;

  const badCode = await call('POST', '/api/auth/signup', {
    body: { email: `y${stamp}@t.com`, password: 'rahasia123', name: 'Y', joinCode: 'ZZZZZZ' },
  });
  // Store D1 bisa menolak kode SEBELUM akun dibuat (transaksional) -> 400.
  ok('kode undangan salah -> 400', badCode.status === 400 && /tidak ditemukan/.test(badCode.data.error || ''), JSON.stringify(badCode.data));
  ok('kode salah tidak membuat akun', (await call('POST', '/api/auth/login', { body: { email: `y${stamp}@t.com`, password: 'rahasia123' } })).status === 401);

  section('login & session');
  {
    const bad = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'salahsalah' } });
    ok('password salah -> 401', bad.status === 401 && /salah/i.test(bad.data.error), JSON.stringify(bad.data));

    const good = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'rahasia123' } });
    ok('login berhasil', good.status === 200 && !!good.data.token, JSON.stringify(good.data).slice(0, 120));
    ok('login mengembalikan expiresAt', Number.isFinite(good.data.expiresAt) && good.data.expiresAt > Date.now(), String(good.data.expiresAt));
    ok('login melihat household', good.data.households?.length === 1, JSON.stringify(good.data.households));

    const me = await call('GET', '/api/auth/me', { token: tokenA });
    ok('me mengembalikan nama user', me.data.user?.name === 'Andi', JSON.stringify(me.data.user));
    ok('me mengembalikan household', me.data.households?.length === 1);
    ok('pembuat household berperan owner', me.data.households?.[0]?.role === 'owner', me.data.households?.[0]?.role);

    const noTok = await call('GET', '/api/auth/me');
    ok('tanpa token -> 401', noTok.status === 401);
    const badTok = await call('GET', '/api/auth/me', { token: 'tok_palsu' });
    ok('token ngawur -> 401', badTok.status === 401);
  }

  section('login google (ID token + JWKS)');
  {
    const noCred = await call('POST', '/api/auth/google', { body: {} });
    ok('google tanpa credential -> 400', noCred.status === 400 && /tidak diterima/.test(noCred.data.error || ''), JSON.stringify(noCred.data));

    // GOOGLE_CLIENT_ID dibaca dari req.env per-request
    const noCfg = await worker.fetch(new Request(APP_URL + '/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'x.y.z' }),
    }), { DB: env.DB, ASSETS: assets, PBKDF2_ITERATIONS: '1000' }, {});
    const noCfgData = await noCfg.json();
    ok('env tanpa GOOGLE_CLIENT_ID -> 400 belum dikonfigurasi',
      noCfg.status === 400 && /belum dikonfigurasi/.test(noCfgData.error || ''), JSON.stringify(noCfgData));

    const sub1 = `gsub-rsa-${stamp}`;
    const gEmail1 = `budi.google.${stamp}@gmail.com`;
    const t1 = await signIdToken(rsaKey, googlePayload({ sub: sub1, email: gEmail1, name: 'Budi Google' }));
    const g1 = await call('POST', '/api/auth/google', { body: { credential: t1 } });
    ok('google RS256 200', g1.status === 200, JSON.stringify(g1.data).slice(0, 160));
    ok('google user dari klaim token', g1.data.user?.email === gEmail1 && g1.data.user?.name === 'Budi Google', JSON.stringify(g1.data.user));
    ok('google membuat household', !!g1.data.household?.id, JSON.stringify(g1.data.household));
    ok('google memberi token sesi', !!g1.data.token);
    const gTok = g1.data.token;

    // login ulang dengan credential yang sama -> household lama (idempotent)
    const g2 = await call('POST', '/api/auth/google', { body: { credential: t1 } });
    ok('google ulang -> household sama', g2.status === 200 && g2.data.household?.id === g1.data.household?.id,
      `${g2.data.household?.id} vs ${g1.data.household?.id}`);

    const chatG = await call('POST', '/api/chat', { token: gTok, body: { text: 'gaji 2jt' } });
    ok('user google bisa chat transaksi', chatG.status === 200 && chatG.data.transaction?.amount === 2000000, JSON.stringify(chatG.data).slice(0, 140));

    // ES256 (Google memakai EC P-256; signature raw r||s -> DER di oidc.js)
    const gEmail2 = `cita.ec.${stamp}@gmail.com`;
    const t2 = await signIdToken(ecKey, googlePayload({ sub: `gsub-ec-${stamp}`, email: gEmail2, name: 'Cita EC' }));
    const g3 = await call('POST', '/api/auth/google', { body: { credential: t2 } });
    ok('google ES256 200', g3.status === 200, JSON.stringify(g3.data).slice(0, 120));
    ok('google ES256 user benar', g3.data.user?.email === gEmail2, JSON.stringify(g3.data.user));

    // user password yang login google pertama kali -> akunnya di-link
    const t3 = await signIdToken(rsaKey, googlePayload({ sub: `gsub-link-${stamp}`, email: emailA, name: 'Andi Google' }));
    const g4 = await call('POST', '/api/auth/google', { body: { credential: t3 } });
    ok('google link ke akun email sama', g4.status === 200 && g4.data.user?.id === suA.data.user?.id, JSON.stringify(g4.data.user));
    const relogA = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'rahasia123' } });
    ok('password tetap jalan setelah link google', relogA.status === 200 && !!relogA.data.token, JSON.stringify(relogA.data).slice(0, 80));

    const badAud = await call('POST', '/api/auth/google', {
      body: { credential: await signIdToken(rsaKey, googlePayload({ aud: 'client-lain' })) },
    });
    ok('aud salah -> 400', badAud.status === 400 && /bukan untuk aplikasi/.test(badAud.data.error || ''), JSON.stringify(badAud.data));

    const expired = await call('POST', '/api/auth/google', {
      body: { credential: await signIdToken(rsaKey, googlePayload({ exp: Math.floor(Date.now() / 1000) - 120 })) },
    });
    ok('exp kedaluwarsa -> 400', expired.status === 400 && /kedaluwarsa/.test(expired.data.error || ''), JSON.stringify(expired.data));

    const unverified = await call('POST', '/api/auth/google', {
      body: { credential: await signIdToken(rsaKey, googlePayload({ email_verified: false })) },
    });
    ok('email belum terverifikasi -> 400', unverified.status === 400 && /belum terverifikasi/.test(unverified.data.error || ''), JSON.stringify(unverified.data));

    // payload diganti setelah ditandatangani -> signature mismatch
    const signed = await signIdToken(rsaKey, googlePayload({ sub: 'gsub-asli' }));
    const [h7, , s7] = signed.split('.');
    const tampered = `${h7}.${b64url(enc.encode(JSON.stringify(googlePayload({ sub: 'gsub-palsu' }))))}.${s7}`;
    const badSig = await call('POST', '/api/auth/google', { body: { credential: tampered } });
    ok('payload dipalsukan -> 400 gagal diverifikasi', badSig.status === 400 && /gagal diverifikasi/.test(badSig.data.error || ''), JSON.stringify(badSig.data));

    // rotasi kunci: kid baru tidak ada di cache JWKS -> refetch -> tetap 200
    const rsaKey2 = await makeKey('RS256', 'test-rsa-2');
    jwksKeys = [rsaKey2.jwk, ecKey.jwk];
    const t8 = await signIdToken(rsaKey2, googlePayload({ sub: `gsub-rotasi-${stamp}`, email: `rotasi.${stamp}@gmail.com`, name: 'Rotasi Kunci' }));
    const g8 = await call('POST', '/api/auth/google', { body: { credential: t8 } });
    ok('kid baru (rotasi JWKS) -> 200', g8.status === 200, JSON.stringify(g8.data).slice(0, 120));
  }

  section('chat multi-transaksi & data bersama');
  {
    const gate = await call('POST', '/api/chat', { body: { text: 'gaji 1jt' } });
    ok('chat tanpa login ditolak', gate.status === 401);

    const c1 = await call('POST', '/api/chat', { token: tokenA, body: { text: 'gaji 8jt' } });
    ok('Andi catat gaji', c1.status === 200 && c1.data.transaction?.amount === 8000000, JSON.stringify(c1.data).slice(0, 140));
    ok('saldo setelah gaji 8jt', c1.data.totals?.balance === 8000000, JSON.stringify(c1.data.totals));

    const c2 = await call('POST', '/api/chat', { token: tokenB, body: { text: 'beli nasi 25rb sama kopi 15rb' } });
    ok('Siti catat 2 transaksi', c2.status === 200 && c2.data.transactions?.length === 2, JSON.stringify(c2.data).slice(0, 160));
    const sum = (c2.data.transactions || []).reduce((a, t) => a + t.amount, 0);
    ok('total nominal multi benar', sum === 40000, String(sum));
    ok('saldo setelah 2 transaksi 7,96jt', c2.data.totals?.balance === 7960000, JSON.stringify(c2.data.totals));

    const c3 = await call('POST', '/api/chat', { token: tokenA, body: { text: 'bayar cicilan 1,2jt' } });
    ok('format 1,2jt diparse 1.200.000', c3.data.transaction?.amount === 1200000, JSON.stringify(c3.data.transaction));

    const stA = await call('GET', '/api/state', { token: tokenA });
    const stB = await call('GET', '/api/state', { token: tokenB });
    ok('Andi melihat 4 transaksi', stA.data.transactions?.length === 4, String(stA.data.transactions?.length));
    ok('Siti melihat transaksi yang sama', stB.data.transactions?.length === 4, String(stB.data.transactions?.length));
    ok('saldo konsisten antar user', stA.data.totals.balance === stB.data.totals.balance, `${stA.data.totals.balance} vs ${stB.data.totals.balance}`);
    // 8.000.000 - (25.000 + 15.000 + 1.200.000) = 6.760.000
    ok('total 4 transaksi = 8jt - 1,24jt', stA.data.totals.balance === 6760000, JSON.stringify(stA.data.totals));
    ok('author terisi dari users', stA.data.transactions.every((t) => !!t.author), JSON.stringify(stA.data.transactions.map((t) => t.author)));

    const rekap = await call('POST', '/api/chat', { token: tokenA, body: { text: 'rekap bulan ini' } });
    ok('perintah rekap dijawab', rekap.status === 200 && /Rekap/.test(rekap.data.text), rekap.data.text?.slice(0, 80));
  }

  section('analytics');
  {
    for (const period of ['today', 'week', 'month', 'year', 'all']) {
      const a = await call('GET', `/api/analytics?period=${period}`, { token: tokenA });
      ok(`analytics ${period} 200`, a.status === 200, JSON.stringify(a.data).slice(0, 120));
      ok(`analytics ${period} ada summary`, typeof a.data?.summary?.income === 'number', JSON.stringify(a.data?.summary));
      ok(`analytics ${period} ada members`, Array.isArray(a.data?.members) && a.data.members.length === 2, JSON.stringify(a.data?.members));
    }
    const a = await call('GET', '/api/analytics?period=month', { token: tokenA });
    ok('total income sesuai', a.data.summary.income === 8000000, JSON.stringify(a.data.summary));
    ok('total expense sesuai', a.data.summary.expense === 1240000, JSON.stringify(a.data.summary));
    ok('kategori pengeluaran terisi', a.data.expenseByCategory.length > 0, JSON.stringify(a.data.expenseByCategory));
    ok('serie harian terisi', Array.isArray(a.data.series) && a.data.series.length > 0);
    const names = a.data.members.map((m) => m.name).sort();
    ok('dua anggota terdaftar', names.join(',') === 'Andi,Siti', names.join(','));
  }

  section('export');
  {
    const csvRes = await worker.fetch(
      new Request('https://app.test/api/export/transactions.csv', { headers: { Authorization: `Bearer ${tokenA}` } }),
      env, {}
    );
    const buf = Buffer.from(await csvRes.arrayBuffer());
    const txt = buf.toString('utf8');
    ok('csv transaksi 200', csvRes.status === 200);
    ok('csv punya BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
    ok('csv berisi header', txt.includes('Tanggal;Jenis;Kategori'));
    ok('csv berisi 4 baris data', txt.trim().split('\r\n').length === 5, String(txt.trim().split('\r\n').length));
    ok('csv content-disposition', /attachment; filename="transaksi-/.test(csvRes.headers.get('content-disposition') || ''));

    const sum = await worker.fetch(
      new Request('https://app.test/api/export/summary.csv', { headers: { Authorization: `Bearer ${tokenA}` } }),
      env, {}
    );
    ok('csv rekap 200', sum.status === 200);
    ok('csv rekap berisi periode', (await sum.text()).includes('Periode'));

    const json = await call('GET', '/api/export/json', { token: tokenA });
    ok('backup json 200', json.status === 200 && json.data.transactions.length === 4, JSON.stringify(json.data).slice(0, 100));
  }

  section('edit & hapus');
  {
    const st = await call('GET', '/api/state', { token: tokenA });
    const target = st.data.transactions[0];
    const before = st.data.totals;
    const wasExpense = target.type === 'expense';
    const afterDelete = wasExpense ? before.balance + target.amount : before.balance - target.amount;

    const patched = await call('PATCH', `/api/transactions/${target.id}`, {
      token: tokenA, body: { note: 'revisi', amount: 9000000 },
    });
    ok('patch 200', patched.status === 200, JSON.stringify(patched.data).slice(0, 140));
    ok('patch ubah nominal', patched.data.transaction?.amount === 9000000, String(patched.data.transaction?.amount));
    const expect = wasExpense ? before.balance + target.amount - 9000000 : before.balance - target.amount + 9000000;
    ok('patch hitung ulang saldo', patched.data.totals?.balance === expect, `${patched.data.totals?.balance} mau ${expect}`);

    const hack = await call('PATCH', `/api/transactions/${target.id}`, { token: tokenA, body: { type: 'ngawur' } });
    ok('patch type ilegal diabaikan', hack.status === 200 && hack.data.transaction.type === target.type);

    const badDate = await call('PATCH', `/api/transactions/${target.id}`, { token: tokenA, body: { date: 'bukan-tanggal' } });
    ok('patch tanggal ilegal diabaikan', badDate.status === 200 && badDate.data.transaction.date === target.date);

    const del = await call('DELETE', `/api/transactions/${target.id}`, { token: tokenA });
    ok('hapus 200', del.status === 200 && del.data.ok === true);
    ok('hapus kembalikan saldo', del.data.totals?.balance === afterDelete, `${del.data.totals?.balance} mau ${afterDelete}`);

    const gone = await call('DELETE', `/api/transactions/${target.id}`, { token: tokenA });
    ok('hapus yang tidak ada -> 404', gone.status === 404);
  }

  section('hapus lewat chat');
  {
    await call('POST', '/api/chat', { token: tokenA, body: { text: 'kopi 15k' } });
    const undo = await call('POST', '/api/chat', { token: tokenA, body: { text: 'hapus terakhir' } });
    ok('hapus terakhir', undo.status === 200 && /Terhapus/.test(undo.data.text), undo.data.text?.slice(0, 60));

    const all = await call('POST', '/api/chat', { token: tokenB, body: { text: 'hapus semua' } });
    ok('hapus semua', all.status === 200 && /dihapus/.test(all.data.text), all.data.text?.slice(0, 60));
    const st = await call('GET', '/api/state', { token: tokenA });
    ok('saldo kembali 0 setelah hapus semua', st.data.totals.balance === 0, JSON.stringify(st.data.totals));
  }

  section('isolasi antar household');
  {
    const stranger = await call('POST', '/api/auth/signup', {
      body: { email: `stranger${stamp}@t.com`, password: 'rahasia123', name: 'Stranger', householdName: 'Buku Sendiri' },
    });
    ok('signup household sendiri', stranger.status === 200, JSON.stringify(stranger.data).slice(0, 120));
    const tokenS = stranger.data.token;
    ok('household berbeda', stranger.data.household.id !== houseId);

    const st = await call('GET', '/api/state', { token: tokenS });
    ok('transaksi stranger kosong', st.data.transactions.length === 0, String(st.data.transactions.length));
    ok('saldo stranger 0', st.data.totals.balance === 0);

    // household milik orang lain tidak boleh bisa diakses
    const foreign = await call('GET', `/api/state?household=${houseId}`, { token: tokenS });
    ok('akses household lain ditolak', foreign.status === 403, JSON.stringify(foreign.data));

    const an = await call('GET', '/api/analytics', { token: tokenS });
    ok('analytics stranger kosong', an.data.members.length === 1 && an.data.members[0].name === 'Stranger', JSON.stringify(an.data.members));

    const csvS = await worker.fetch(
      new Request('https://app.test/api/export/transactions.csv', { headers: { Authorization: `Bearer ${tokenS}` } }),
      env, {}
    );
    ok('csv stranger tidak bocor data lain', (await csvS.text()).trim().split('\r\n').length === 1, 'ada baris tambahan');
  }

  section('logout');
  {
    const out = await call('POST', '/api/auth/logout', { token: tokenA });
    ok('logout 200', out.status === 200 && out.data.ok === true, JSON.stringify(out.data));
    const dead = await call('GET', '/api/auth/me', { token: tokenA });
    ok('token mati setelah logout', dead.status === 401, `status ${dead.status}`);
    const chatDead = await call('POST', '/api/chat', { token: tokenA, body: { text: 'gaji 1rb' } });
    ok('token mati untuk chat juga', chatDead.status === 401, `status ${chatDead.status}`);

    // login ulang menghasilkan token baru yang hidup
    const re = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'rahasia123' } });
    ok('login ulang setelah logout', re.status === 200 && !!re.data.token, JSON.stringify(re.data).slice(0, 80));
    tokenA = re.data.token;
    ok('token baru bisa dipakai', (await call('GET', '/api/auth/me', { token: tokenA })).status === 200);
  }

  section('penanganan error');
  {
    const noText = await call('POST', '/api/chat', { token: tokenA, body: {} });
    ok('chat tanpa text -> 400', noText.status === 400, JSON.stringify(noText.data));

    const noHouse = await call('GET', `/api/state?household=00000000-0000-0000-0000-000000000000`, { token: tokenA });
    ok('household asing -> 403', noHouse.status === 403, JSON.stringify(noHouse.data));

    const noDb = await worker.fetch(new Request('https://app.test/api/state'), { ASSETS: assets }, {});
    const noDbBody = await noDb.text();
    ok('env tanpa DB -> pesan jelas', noDb.status === 500 && /D1/.test(noDbBody), noDbBody.slice(0, 100));
  }
} catch (e) {
  failures.push('CRASH: ' + e.message);
  console.error('\nCRASH', e);
}

/* ---------------- hasil ---------------- */

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
