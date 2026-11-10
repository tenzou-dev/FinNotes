const B = process.env.WORKER_URL || 'https://finnotes.tenzou-dev.workers.dev';

(async () => {
  let r = await fetch(B + '/api/config');
  console.log('config  ', r.status, JSON.stringify(await r.json()));

  r = await fetch(B + '/api/auth/me');
  console.log('me      ', r.status, (await r.text()).slice(0, 70));

  r = await fetch(B + '/');
  const h = await r.text();
  console.log('index   ', r.status, h.length + ' bytes');
  console.log('  title  ', h.includes('Kasir Chat') ? 'OK' : 'MISSING');
  console.log('  module ', h.includes('type="module"') ? 'OK' : 'MISSING');

  r = await fetch(B + '/api/tidak-ada');
  console.log('404     ', r.status);

  r = await fetch(B + '/api/state');
  console.log('no auth ', r.status, (await r.text()).slice(0, 60));

  for (const a of ['/app.js', '/api.js', '/auth.js', '/supa.js']) {
    r = await fetch(B + a);
    console.log('asset   ', a.padEnd(11), r.status, r.headers.get('content-type'));
  }
})();
