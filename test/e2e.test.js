'use strict';

const BASE = process.env.BASE || 'http://localhost:3312';
const stamp = Date.now();

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
};

const jar = () => ({ cookie: '' });

function cookieHeader(jar) { return jar.cookie ? { cookie: jar.cookie } : {}; }

function absorb(jar, res) {
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) jar.cookie = c.split(';')[0];
}

async function call(jar, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookieHeader(jar) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(jar, res);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const chat = (jar, text) => call(jar, 'POST', '/api/chat', { text });
const state = (jar) => call(jar, 'GET', '/api/state');
const me = (jar) => call(jar, 'GET', '/api/auth/me');

(async () => {
  /* ---------- auth gate ---------- */
  const anon = jar();
  const gated = await state(anon);
  ok('api butuh login', gated.status === 401, `status ${gated.status}`);
  const gatedChat = await chat(anon, 'gaji 1jt');
  ok('chat tanpa login ditolak', gatedChat.status === 401, `status ${gatedChat.status}`);

  /* ---------- signup owner ---------- */
  const andi = jar();
  const emailA = `andi${stamp}@test.com`;
  const su = await call(andi, 'POST', '/api/auth/signup', { email: emailA, password: 'rahasia123', name: 'Andi', householdName: 'Rumah Andi' });
  ok('signup berhasil', su.status === 200 && !!su.data.user, JSON.stringify(su.data));
  ok('household dibuat', !!su.data.household?.id && !!su.data.household?.join_code, JSON.stringify(su.data.household));
  const houseId = su.data.household.id;
  const joinCode = su.data.household.join_code;

  const dup = await call(jar(), 'POST', '/api/auth/signup', { email: emailA, password: 'rahasia123', name: 'Duplikat' });
  ok('email duplikat ditolak', dup.status === 400 && /sudah terdaftar/.test(dup.data.error), JSON.stringify(dup.data));

  const weak = await call(jar(), 'POST', '/api/auth/signup', { email: `x${stamp}@t.com`, password: '123', name: 'X' });
  ok('password lemah ditolak', weak.status === 400 && /minimal 6/.test(weak.data.error), JSON.stringify(weak.data));

  const m1 = await me(andi);
  ok('me mengembalikan user', m1.data.user?.email === emailA, JSON.stringify(m1.data));
  ok('me punya household', m1.data.households?.length === 1);

  /* ---------- signup istri dengan join code ---------- */
  const siti = jar();
  const emailB = `siti${stamp}@test.com`;
  const su2 = await call(siti, 'POST', '/api/auth/signup', { email: emailB, password: 'rahasia123', name: 'Siti', joinCode });
  ok('istri gabung via kode', su2.status === 200, JSON.stringify(su2.data));
  ok('punya household yang sama', su2.data.household?.id === houseId, `${su2.data.household?.id} vs ${houseId}`);

  const badCode = await call(jar(), 'POST', '/api/auth/signup', { email: `y${stamp}@t.com`, password: 'rahasia123', name: 'Y', joinCode: 'ZZZZZZ' });
  ok('kode salah ditolak', badCode.status === 400 && /tidak ditemukan/.test(badCode.data.error), JSON.stringify(badCode.data));

  /* ---------- data bersama ---------- */
  await chat(andi, 'gaji 8jt');
  await chat(andi, 'bayar cicilan 1,2jt');
  await chat(siti, 'beli groceries 450rb');
  await chat(siti, 'jualan kue 300rb');

  const sA = await state(andi);
  const sB = await state(siti);
  ok('andi lihat 4 transaksi', sA.data.transactions.length === 4, `${sA.data.transactions.length}`);
  ok('siti lihat 4 transaksi (shared)', sB.data.transactions.length === 4, `${sB.data.transactions.length}`);
  ok('total sama', sA.data.totals.balance === sB.data.totals.balance, `${sA.data.totals.balance} vs ${sB.data.totals.balance}`);
  ok('total benar', sA.data.totals.income === 8300000 && sA.data.totals.expense === 1650000,
    JSON.stringify(sA.data.totals));

  const authors = new Set(sA.data.transactions.map((t) => t.author));
  ok('penulis transaksi berbeda', authors.size === 2, [...authors].join(','));

  /* ---------- multi transaksi ---------- */
  const before = (await state(andi)).data.transactions.length;
  const multi = await chat(andi, 'beli nasi 25rb sama kopi 15rb sama teh 8k');
  ok('chat multi dicatat', multi.data.transactions?.length === 3, JSON.stringify(multi.data.transactions?.map((t) => t.amount)));
  ok('tambah 3 transaksi', (await state(andi)).data.transactions.length === before + 3);
  ok('jumlah multi = 48rb', multi.data.transactions?.reduce((a, t) => a + t.amount, 0) === 48000);

  /* ---------- analytics ---------- */
  const an = await call(andi, 'GET', '/api/analytics?period=month');
  ok('analytics ok', an.status === 200, JSON.stringify(an.data).slice(0, 120));
  ok('punya kategori pengeluaran', an.data.expenseByCategory?.length > 0);
  ok('punya seri harian', Array.isArray(an.data.series));
  ok('ada warna & persen', !!an.data.expenseByCategory?.[0]?.color && an.data.expenseByCategory?.[0]?.pct >= 0);
  ok('punya 2 anggota', an.data.members?.length === 2, JSON.stringify(an.data.members?.map((m) => m.name)));
  ok('ada perbandingan periode', typeof an.data.comparison?.expense === 'number');

  const anAll = await call(andi, 'GET', '/api/analytics?period=all');
  ok('analytics all ok', anAll.status === 200 && anAll.data.summary.count > 0);

  /* ---------- export ---------- */
  const csvTxRaw = await fetch(BASE + '/api/export/transactions.csv', { headers: cookieHeader(andi) });
  const csvBuf = Buffer.from(await csvTxRaw.arrayBuffer());
  ok('export transaksi 200', csvTxRaw.status === 200);
  const csvTxt = csvBuf.toString('utf8');
  ok('export transaksi csv', csvTxt.includes('Tanggal;Jenis;Kategori'));
  ok('export punya BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf);
  ok('export filename', /attachment; filename="transaksi-/.test(csvTxRaw.headers.get('content-disposition') || ''));

  const csvSum = await call(andi, 'GET', '/api/export/summary.csv?period=month');
  ok('export rekap 200', csvSum.status === 200 && String(csvSum.data).includes('Rekap Keuangan'));

  const json = await call(andi, 'GET', '/api/export/json');
  ok('export json 200', json.status === 200 && Array.isArray(json.data.transactions));

  /* ---------- edit & hapus ---------- */
  const newest = (await state(andi)).data;
  const target = newest.transactions[0];
  const beforePatch = newest.totals;
  const wasExpense = target.type === 'expense';

  // kalau baris ini dihapus sepenuhnya, saldo jadi ini
  const afterDelete = wasExpense
    ? beforePatch.balance + target.amount
    : beforePatch.balance - target.amount;

  const patched = await call(andi, 'PATCH', `/api/transactions/${target.id}`, { category: 'Gaji', note: 'revisi', amount: 9000000 });
  ok('patch ok', patched.status === 200 && patched.data.transaction.note === 'revisi', JSON.stringify(patched.data));
  ok('patch nominal', patched.data.transaction.amount === 9000000, String(patched.data.transaction?.amount));

  const expectedAfterPatch = wasExpense
    ? beforePatch.balance + target.amount - 9000000
    : beforePatch.balance - target.amount + 9000000;
  ok('patch update saldo', patched.data.totals.balance === expectedAfterPatch,
    `${beforePatch.balance} -> ${patched.data.totals.balance}, mau ${expectedAfterPatch}`);

  const badPatch = await call(andi, 'PATCH', `/api/transactions/${target.id}`, { type: 'hacked' });
  ok('patch type ilegal diabaikan', badPatch.status === 200 && badPatch.data.transaction.type === target.type, JSON.stringify(badPatch.data));

  const badDate = await call(andi, 'PATCH', `/api/transactions/${target.id}`, { date: 'bukan-tanggal' });
  ok('patch tanggal ilegal diabaikan', badDate.status === 200 && badDate.data.transaction.date === target.date);

  const del = await call(andi, 'DELETE', `/api/transactions/${target.id}`);
  ok('hapus ok', del.status === 200 && del.data.ok === true);
  ok('hapus kembalikan saldo tanpa baris itu', del.data.totals.balance === afterDelete, `${del.data.totals.balance} vs ${afterDelete}`);
  ok('hapus kurangi jumlah transaksi', del.data.totals.count === beforePatch.count - 1);

  const notFound = await call(andi, 'DELETE', '/api/transactions/tidak-ada');
  ok('hapus id salah -> 404', notFound.status === 404, `status ${notFound.status}`);

  /* ---------- isolasi antar household ---------- */
  const stranger = jar();
  const su3 = await call(stranger, 'POST', '/api/auth/signup', { email: `stranger${stamp}@t.com`, password: 'rahasia123', name: 'Stranger', householdName: 'Buku Sendiri' });
  ok('user baru punya household sendiri', su3.data.household?.id !== houseId);
  const sC = await state(stranger);
  ok('tidak lihat data orang lain', sC.data.transactions.length === 0, `${sC.data.transactions.length}`);
  const crossDelete = await call(stranger, 'DELETE', `/api/transactions/${sA.data.transactions[0].id}`);
  ok('tidak bisa hapus milik orang lain', crossDelete.status === 404 || crossDelete.status === 403, `status ${crossDelete.status}`);

  /* ---------- login ---------- */
  const logout = await call(andi, 'POST', '/api/auth/logout');
  ok('logout ok', logout.status === 200);
  const afterLogout = await state(andi);
  ok('setelah logout tidak bisa akses', afterLogout.status === 401, `status ${afterLogout.status}`);

  const relogin = jar();
  const li = await call(relogin, 'POST', '/api/auth/login', { email: emailA, password: 'rahasia123' });
  ok('login ulang berhasil', li.status === 200 && li.data.user?.email === emailA);
  ok('data kembali ada setelah login', (await state(relogin)).data.transactions.length > 0);

  const wrongPass = await call(jar(), 'POST', '/api/auth/login', { email: emailA, password: 'salahpassword' });
  ok('password salah ditolak', wrongPass.status === 401, `status ${wrongPass.status}`);

  const sFinal = await state(relogin);
  ok('saldo konsisten setelah login ulang', sFinal.data.totals.balance === afterDelete, JSON.stringify(sFinal.data.totals));
  ok('jumlah transaksi tetap', sFinal.data.totals.count === beforePatch.count - 1, `${sFinal.data.totals.count} vs ${beforePatch.count - 1}`);

  console.log(fail ? 'FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n') + '\n' : '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
