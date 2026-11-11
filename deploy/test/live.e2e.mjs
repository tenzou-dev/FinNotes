/**
 * Uji alur produksi nyata terhadap Worker yang sudah ter-deploy.
 * Butuh env WORKER_URL (default: https://finnotes.tenzou.dev).
 */
const B = process.env.WORKER_URL || 'https://finnotes.tenzou.dev';
const MAIL = (n) => `kjtest.${n}.${Date.now()}@gmail.com`;

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fails.push(name + (extra ? ' :: ' + String(extra).slice(0, 160) : '')); console.log('  FAIL', name, extra); }
};
const section = (t) => console.log('\n' + t);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(B + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}

try {
  section('signup + buat household');
  const andi = await call('POST', '/api/auth/signup', {
    body: { email: MAIL('andi'), password: 'rahasia123456', name: 'Andi', householdName: 'Rumah Andi' },
  });
  ok('signup Andi 200', andi.status === 200, JSON.stringify(andi.data));
  if (andi.status !== 200) {
    // Kalau signup awal gagal (mis. config), sisa test tidak bisa jalan.
    console.log('\nSignup gagal - sisa test dilewati.');
    throw new Error('SKIP: signup awal gagal: ' + JSON.stringify(andi.data));
  }
  ok('token diberikan', !!andi.data.token, JSON.stringify(andi.data).slice(0, 120));
  ok('expiresAt diberikan (ms)', Number.isFinite(andi.data.expiresAt) && andi.data.expiresAt > Date.now(), String(andi.data.expiresAt));
  ok('tanpa refresh_token', andi.data.refresh_token === undefined, String(andi.data.refresh_token));
  ok('household terbentuk', andi.data.household?.name === 'Rumah Andi', JSON.stringify(andi.data.household));
  ok('join_code 6 karakter A-Z2-9', /^[A-Z2-9]{6}$/.test(andi.data.household?.join_code || ''), andi.data.household?.join_code);
  const tA = andi.data.token;
  const code = andi.data.household.join_code;

  section('profile & role');
  const meA = await call('GET', '/api/auth/me', { token: tA });
  ok('me nama user', meA.data.user?.name === 'Andi', JSON.stringify(meA.data.user));
  ok('me punya 1 household', meA.data.households?.length === 1, JSON.stringify(meA.data.households));
  // Pembuat household berperan owner (signUp store D1)
  ok('pembuat household berperan owner', meA.data.households?.[0]?.role === 'owner', meA.data.households?.[0]?.role);

  section('signup kedua + gabung via kode');
  const siti = await call('POST', '/api/auth/signup', {
    body: { email: MAIL('siti'), password: 'rahasia123456', name: 'Siti', joinCode: code },
  });
  ok('signup Siti 200', siti.status === 200, JSON.stringify(siti.data).slice(0, 140));
  ok('Siti masuk household Andi', siti.data.household?.id === andi.data.household.id, `${siti.data.household?.id} vs ${andi.data.household.id}`);
  ok('gabung tanpa warning', !siti.data.warning, siti.data.warning);
  const tB = siti.data.token;
  // Yang gabung lewat kode berperan member (store D1: role 'member')
  const meB = await call('GET', '/api/auth/me', { token: tB });
  ok('yang gabung lewat kode berperan member', meB.data.households?.[0]?.role === 'member', meB.data.households?.[0]?.role);

  section('data bersama & isolasi');
  const c1 = await call('POST', '/api/chat', { token: tA, body: { text: 'gaji 5jt' } });
  ok('Andi catat gaji', c1.status === 200 && c1.data.transaction?.amount === 5000000, JSON.stringify(c1.data).slice(0, 140));
  const c2 = await call('POST', '/api/chat', { token: tB, body: { text: 'beli kopi 15rb' } });
  ok('Siti catat pengeluaran', c2.status === 200 && c2.data.transaction?.amount === 15000, JSON.stringify(c2.data).slice(0, 140));
  const stB = await call('GET', '/api/state', { token: tB });
  ok('Siti melihat 2 transaksi', stB.data.transactions?.length === 2, String(stB.data.transactions?.length));
  ok('author terisi (join users)', stB.data.transactions.every((t) => !!t.author), JSON.stringify(stB.data.transactions.map((t) => t.author)));
  ok('balance konsisten', stB.data.totals.balance === 4985000, JSON.stringify(stB.data.totals));

  section('household stranger tidak boleh bocor');
  const yuni = await call('POST', '/api/auth/signup', {
    body: { email: MAIL('yuni'), password: 'rahasia123456', name: 'Yuni', householdName: 'Rumah Yuni' },
  });
  ok('signup Yuni 200', yuni.status === 200, JSON.stringify(yuni.data).slice(0, 120));
  ok('Yuni household terpisah', yuni.data.household?.id !== andi.data.household.id);
  const tY = yuni.data.token;
  const stY = await call('GET', '/api/state', { token: tY });
  ok('Yuni lihat 0 transaksi', stY.data.transactions?.length === 0, String(stY.data.transactions?.length));
  const xh = await call('GET', '/api/state?household=' + andi.data.household.id, { token: tY });
  ok('Yuni akses household Andi -> 403', xh.status === 403, xh.status);
  const an = await call('GET', '/api/analytics?period=all', { token: tY });
  ok('Yuni analytics kosong', (an.data.summary?.income || 0) === 0, JSON.stringify(an.data.summary));

  section('kode undangan salah -> 400, akun tidak jadi');
  const zakiMail = MAIL('zaki');
  const zaki = await call('POST', '/api/auth/signup', {
    body: { email: zakiMail, password: 'rahasia123456', name: 'Zaki', joinCode: 'ZZZZZZ' },
  });
  // Store D1 menolak kode SEBELUM akun dibuat -> 400 polos, tanpa fallback.
  ok('signup kode salah -> 400', zaki.status === 400 && /tidak ditemukan/.test(zaki.data.error || ''), JSON.stringify(zaki.data).slice(0, 140));
  ok('tidak ada household cadangan', zaki.data.household === undefined, JSON.stringify(zaki.data.household));
  const zakiLogin = await call('POST', '/api/auth/login', { body: { email: zakiMail, password: 'rahasia123456' } });
  ok('akun Zaki tidak jadi dibuat', zakiLogin.status === 401, `status ${zakiLogin.status}`);

  // lanjut pakai user valid untuk edit & hapus
  const cZ = await call('POST', '/api/chat', { token: tY, body: { text: 'gaji 2jt' } });
  ok('Yuni bisa catat transaksi', cZ.status === 200 && cZ.data.transaction?.amount === 2000000, JSON.stringify(cZ.data).slice(0, 140));

  section('edit & hapus');
  // Target harus transaksi milik Yuni yang baru saja dicatat (cZ).
  const target = cZ.data.transaction;
  const pa = await call('PATCH', '/api/transactions/' + target.id, { token: tY, body: { amount: 2500000 } });
  ok('patch 200', pa.status === 200 && pa.data.transaction?.amount === 2500000, JSON.stringify(pa.data).slice(0, 140));
  const de = await call('DELETE', '/api/transactions/' + target.id, { token: tY });
  ok('delete 200 (bukan 405)', de.status === 200, `${de.status} ${JSON.stringify(de.data).slice(0, 100)}`);
  const stZ2 = await call('GET', '/api/state', { token: tY });
  ok('saldo Yuni kembali 0', stZ2.data.totals.balance === 0, JSON.stringify(stZ2.data.totals));

  section('login ulang');
  const wrong = await call('POST', '/api/auth/login', { body: { email: MAIL('andi').replace(/\.\d+@/, '@').replace('kjtest.andi', 'x'), password: 'salahsalah' } });
  ok('password salah -> 401', wrong.status === 401, wrong.status);
  const relog = await call('POST', '/api/auth/login', { body: { email: andi.data.user.email, password: 'rahasia123456' } });
  ok('login ulang 200', relog.status === 200 && !!relog.data.token, JSON.stringify(relog.data).slice(0, 120));
  ok('login lihat household', relog.data.households?.length === 1);
  const meR = await call('GET', '/api/auth/me', { token: relog.data.token });
  ok('sesi baru valid', meR.status === 200 && meR.data.households?.length === 1, meR.status);

  section('auth gate');
  ok('token ngawur -> 401', (await call('GET', '/api/auth/me', { token: 'tok_palsu' })).status === 401);
  ok('chat tanpa login -> 401', (await call('POST', '/api/chat', { body: { text: 'x' } })).status === 401);
  ok('chat tanpa text -> 400', (await call('POST', '/api/chat', { token: tA, body: {} })).status === 400);
  // endpoint google: tanpa kredensial Google alur penuh tidak bisa diuji,
  // tapi gate-nya harus hidup dan menolak payload kosong/token ngawur.
  ok('google tanpa credential -> 400', (await call('POST', '/api/auth/google', { body: {} })).status === 400);
  ok('google token ngawur -> 400', (await call('POST', '/api/auth/google', { body: { credential: 'bukan-jwt' } })).status === 400);

  section('export');
  const csv = await fetch(B + '/api/export/transactions.csv', { headers: { Authorization: 'Bearer ' + tB } });
  const csvBuf = Buffer.from(await csv.arrayBuffer());
  // BOM harus dicek dari byte mentah: Response.text() melepas BOM saat decode UTF-8.
  const csvText = csvBuf.toString('utf8');
  ok('csv 200', csv.status === 200, csv.status);
  ok('csv ada BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, Array.from(csvBuf.slice(0, 3)).join(','));
  ok('csv ada data', csvText.toLowerCase().includes('kopi'), csvText.slice(0, 120));
  ok('csv content-disposition', /attachment/.test(csv.headers.get('content-disposition') || ''), csv.headers.get('content-disposition'));
} catch (e) {
  if (!String(e.message).startsWith('SKIP:')) {
    fails.push('CRASH: ' + e.message);
    console.error('\nCRASH', e);
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('\nSemua alur produksi lulus. User test yang dibuat:');
  console.log('  andi, siti, yuni (prefix kjtest.*@gmail.com)');
}
