'use strict';

const path = require('node:path');
const express = require('express');

const store = require('./src/store');
const oidc = require('./src/oidc');
const analytics = require('./src/analytics');
const csv = require('./src/csv');
const { handleMessage, confirmType, formatDate, humanDate, txCard } = require('./src/assistant');
const { INCOME, EXPENSE, EXAMPLES } = require('./src/parser');
const { CATEGORIES } = require('./src/meta');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/config', (req, res) => {
  res.json({
    backend: store.BACKEND,
    local: true,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  });
});

/* ---------------- auth ---------------- */

function tokenFrom(req) {
  const h = req.get('authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function attachUser(req, _res, next) {
  const token = tokenFrom(req);
  if (!token) return next();
  try {
    const s = await store.getSession(token);
    if (s) {
      req.authToken = token;
      req.user = s.user;
      req.households = s.households || [];
    }
  } catch (e) {
    console.error('auth error', e.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Belum login' });
  next();
}

async function requireHousehold(req, res, next) {
  try {
    const id = req.query.household || req.body?.householdId || req.householdId || req.households?.[0]?.id;
    if (!id) return res.status(400).json({ error: 'Belum ada household' });
    await store.getMembership(req.authToken, req.user.id, id);
    req.householdId = id;
    req.household = req.households?.find((x) => x.id === id) || (await store.getHousehold(req.authToken, id));
    next();
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
}

function ctxOf(req) {
  return {
    store,
    accessToken: req.authToken || null,
    householdId: req.householdId,
    userId: req.user.id,
    displayName: req.user.name,
  };
}

/**
 * Signup + household dalam SATU transaksi logis store: kalau kode undangan
 * salah, akun tidak jadi dibuat (400) — beda dengan era Supabase yang tidak
 * bisa di-rollback. Response: { user, household, token, expiresAt }.
 */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, householdName, joinCode } = req.body || {};
    const r = await store.signUp({ email, password, name, householdName, joinCode });
    res.json({ ...r, backend: store.BACKEND });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const r = await store.signIn({ email: req.body?.email, password: req.body?.password });
    res.json({ ...r, backend: store.BACKEND });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

/** Logout = hapus baris sesi di DB; token langsung mati. */
app.post('/api/auth/logout', async (req, res) => {
  await store.logout(tokenFrom(req));
  res.json({ ok: true });
});

/**
 * Login "Lanjut dengan Google" (GIS): frontend mengirim credential (ID token
 * JWT) dari tombol Google; server memverifikasi tanda tangan + klaim lewat
 * JWKS Google, lalu membuat/menghubungkan akun + household.
 */
app.post('/api/auth/google', async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const credential = String(req.body?.credential || '').trim();
    const profile = await oidc.verifyGoogleIdToken(credential, clientId);
    const r = await store.signInWithGoogle(profile);
    res.json({ ...r, backend: store.BACKEND });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/auth/me', attachUser, requireAuth, (req, res) => {
  res.json({ user: req.user, households: req.households || [], backend: store.BACKEND });
});

app.post('/api/households', attachUser, requireAuth, async (req, res) => {
  try {
    const h = await store.createHousehold(req.authToken, req.body?.name);
    res.json({ household: h });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/households/join', attachUser, requireAuth, async (req, res) => {
  try {
    const h = await store.joinHousehold(req.authToken, req.body?.code);
    res.json({ household: h });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- data ---------------- */

app.get('/api/state', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const [totals, transactions, messages] = await Promise.all([
      store.totals(ctx.accessToken, ctx.householdId),
      store.listTransactions(ctx.accessToken, ctx.householdId, 500),
      store.lastMessages(ctx.accessToken, ctx.householdId, 60),
    ]);
    res.json({
      user: req.user,
      household: req.household,
      totals,
      transactions,
      messages,
      examples: EXAMPLES,
      categories: CATEGORIES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const { text, draft, type } = req.body || {};
    let out;
    if (draft && (type === INCOME || type === EXPENSE)) {
      out = await confirmType(ctx, draft, type);
      await store.insertMessage(ctx.accessToken, ctx.householdId, ctx.userId, 'user',
        type === INCOME ? `+ ${draft.amount}` : `- ${draft.amount}`, null);
    } else {
      if (text === undefined || text === null) return res.status(400).json({ error: 'text required' });
      out = await handleMessage(ctx, text);
      await store.insertMessage(ctx.accessToken, ctx.householdId, ctx.userId, 'user', String(text), null);
    }
    await store.insertMessage(ctx.accessToken, ctx.householdId, ctx.userId, 'bot', out.text, out);
    res.json({ ...out, totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    console.error('chat error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/transactions/:id', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const id = String(req.params.id);
    const patch = req.body || {};
    if (patch.type && ![INCOME, EXPENSE].includes(patch.type)) delete patch.type;
    if (patch.amount != null) patch.amount = Number(patch.amount);
    if (patch.date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) delete patch.date;

    const t = await store.updateTransaction(ctx.accessToken, ctx.householdId, id, patch);
    if (!t) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    res.json({ transaction: txCard(t), totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/transactions/:id', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const ok = await store.deleteTransaction(ctx.accessToken, ctx.householdId, String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/analytics', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    res.json(await analytics.build(ctxOf(req), req.query.period || 'month'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/export/transactions.csv', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const txs = await store.listTransactions(ctx.accessToken, ctx.householdId, 20000);
    const stamp = formatDate(new Date());
    csv.download(res, `transaksi-${stamp}.csv`, csv.transactionsCsv(txs));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/export/summary.csv', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const a = await analytics.build(ctxOf(req), req.query.period || 'month');
    csv.download(res, `rekap-${a.period}-${a.to}.csv`, csv.summaryCsv(a));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/export/json', attachUser, requireAuth, requireHousehold, async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const txs = await store.listTransactions(ctx.accessToken, ctx.householdId, 20000);
    res.setHeader('Content-Disposition', `attachment; filename="keuangan-${formatDate(new Date())}.json"`);
    res.json({ exportedAt: new Date().toISOString(), household: req.household, totals: await store.totals(ctx.accessToken, ctx.householdId), transactions: txs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  FinNotes v0.3  ->  http://localhost:${PORT}`);
    console.log(`  backend: ${store.BACKEND} (SQLITE_FILE lokal)\n`);
  });
}

module.exports = app;
