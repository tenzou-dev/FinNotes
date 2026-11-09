/**
 * E2E untuk Cloudflare Worker terhadap mock Supabase.
 *
 * Menjalankan worker.js sungguhan (modul ESM yang sama dengan yang di-deploy)
 * dengan binding ASSETS tiruan dan SUPABASE_URL yang menunjuk ke mock
 * PostgREST/GoTrue lokal. Jadi yang ter-cover di sini: routing Worker,
 * parsing body/param, adapter Supabase, dan seluruh alur bisnis.
 *
 * RLS tidak diuji di sini (mock tidak mensimulasikan RLS).
 *
 * Jalankan: node deploy/test/worker.test.mjs
 */

import { createMockSupabase, ANON_KEY, reset } from '../mock-supabase.mjs';
import worker from '../worker.js';

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

/* ---------------- server mock ---------------- */

const mock = createMockSupabase();
await new Promise((r) => mock.listen(0, r));
const mockPort = mock.address().port;
const SUPA_URL = `http://localhost:${mockPort}`;

const assets = {
  fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`, {
    headers: { 'Content-Type': 'text/plain' },
  }),
};

const env = { SUPABASE_URL: SUPA_URL, SUPABASE_ANON_KEY: ANON_KEY, ASSETS: assets };

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

/* ---------------- tests ---------------- */

try {
  section('aset statis & routing');
  {
    const r = await worker.fetch(new Request('https://app.test/login.html'), env, {});
    ok('login.html dilayani ASSETS', (await r.text()) === 'asset:/login.html');
    const cfg = await call('GET', '/api/config');
    ok('api/config backend supabase', cfg.data.backend === 'supabase', JSON.stringify(cfg.data));
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
  ok('signup membuat household', !!suA.data.household?.id && !!suA.data.household?.join_code, JSON.stringify(suA.data.household));
  const tokenA = suA.data.token;
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
  // Di Supabase, akun sudah dibuat Supabase Auth sebelum join dicoba sehingga
  // tidak bisa di-rollback. Worker lalu membuat household cadangan dan
  // mengembalikan warning - bukan 400. Assert perilaku yang memang itu.
  ok('kode undangan salah -> 200 + warning', badCode.status === 200 && !!badCode.data.warning, JSON.stringify(badCode.data).slice(0, 200));
  ok('kode undangan salah tetap dapat household cadangan', !!badCode.data.household?.id, JSON.stringify(badCode.data.household));
  ok('household cadangan pakai nama default', badCode.data.household?.name === 'Rumah Tangga', String(badCode.data.household?.name));
  ok('signup mengembalikan refresh_token', !!badCode.data.refresh_token, String(badCode.data.refresh_token));

  // Regression: user yang kodenya ditolak harus tetap bisa memakai aplikasi.
  // Kalau household cadangan tidak terbentuk, user terjebak tanpa buku.
  {
    const t = badCode.data.token;
    const badMe = await call('GET', '/api/auth/me', { token: t });
    ok('user kode salah punya household (tidak terjebak)', badMe.data.households?.length === 1, JSON.stringify(badMe.data.households));
    const badState = await call('GET', '/api/state', { token: t });
    ok('user kode salah bisa buka app', badState.status === 200 && badState.data.household?.id === badCode.data.household.id, JSON.stringify(badState.data.household));
    const badChat = await call('POST', '/api/chat', { token: t, body: { text: 'gaji 3jt' } });
    ok('user kode salah bisa catat transaksi', badChat.status === 200 && badChat.data.transaction?.amount === 3000000, JSON.stringify(badChat.data).slice(0, 140));
  }

  section('login & session');
  {
    const bad = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'salahsalah' } });
    ok('password salah -> 401', bad.status === 401 && /salah/i.test(bad.data.error), JSON.stringify(bad.data));

    const good = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'rahasia123' } });
    ok('login berhasil', good.status === 200 && !!good.data.token, JSON.stringify(good.data).slice(0, 120));
    ok('login mengembalikan refresh_token', !!good.data.refresh_token, String(good.data.refresh_token));
    ok('login melihat household', good.data.households?.length === 1, JSON.stringify(good.data.households));

    const me = await call('GET', '/api/auth/me', { token: tokenA });
    ok('me mengembalikan nama user', me.data.user?.name === 'Andi', JSON.stringify(me.data.user));
    ok('me mengembalikan household', me.data.households?.length === 1);

    const noTok = await call('GET', '/api/auth/me');
    ok('tanpa token -> 401', noTok.status === 401);
    const badTok = await call('GET', '/api/auth/me', { token: 'tok_palsu' });
    ok('token ngawur -> 401', badTok.status === 401);
  }

  section('chat multi-transaksi & data bersama');
  {
    const gate = await call('POST', '/api/chat', { body: { text: 'gaji 1jt' } });
    ok('chat tanpa login ditolak', gate.status === 401);

    const c1 = await call('POST', '/api/chat', { token: tokenA, body: { text: 'gaji 8jt' } });
    ok('Andi catat gaji', c1.status === 200 && c1.data.transaction?.amount === 8000000, JSON.stringify(c1.data).slice(0, 140));
    ok('baldo setelah gaji 8jt', c1.data.totals?.balance === 8000000, JSON.stringify(c1.data.totals));

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
    ok('author terisi dari profiles', stA.data.transactions.every((t) => !!t.author), JSON.stringify(stA.data.transactions.map((t) => t.author)));

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

  section('penanganan error');
  {
    const noText = await call('POST', '/api/chat', { token: tokenA, body: {} });
    ok('chat tanpa text -> 400', noText.status === 400, JSON.stringify(noText.data));

    const noHouse = await call('GET', `/api/state?household=00000000-0000-0000-0000-000000000000`, { token: tokenA });
    ok('household asing -> 403', noHouse.status === 403, JSON.stringify(noHouse.data));

    const emptyEnv = { ...env, SUPABASE_ANON_KEY: '' };
    const r2 = await worker.fetch(new Request('https://app.test/api/state'), emptyEnv, {});
    const body2 = await r2.text();
    ok('env hilang -> pesan jelas', body2.includes('SUPABASE'), body2.slice(0, 100));
  }
} catch (e) {
  failures.push('CRASH: ' + e.message);
  console.error('\nCRASH', e);
}

/* ---------------- hasil ---------------- */

mock.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
