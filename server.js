'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./src/store');
const session = require('./src/session');
const analytics = require('./src/analytics');
const csv = require('./src/csv');
const { handleMessage, confirmType, formatDate, humanDate, txCard } = require('./src/assistant');
const { INCOME, EXPENSE, EXAMPLES } = require('./src/parser');
const { CATEGORIES } = require('./src/meta');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/config', (req, res) => {
  res.json({
    backend: store.BACKEND,
    supabase: {
      url: process.env.SUPABASE_URL || null,
      anonKey: process.env.SUPABASE_ANON_KEY || null,
    },
  });
});

/* ---------------- auth ---------------- */

function tokenFrom(req) {
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.kj_token || null;
}

async function attachUser(req, res, next) {
  const token = tokenFrom(req);
  try {
    if (store.BACKEND === 'supabase') {
      if (!token) return next();
      const s = await store.getSession(token);
      if (s) {
        req.authToken = token;
        req.user = s.user;
        req.households = s.households;
      }
    } else {
      const raw = session.readSession(req);
      if (raw) {
        const households = await store.listHouseholds(null, raw.u);
        if (households.length) {
          const memberships = await Promise.all(
            households.map((h) => store.getMembership(null, raw.u, h.id).catch(() => null))
          );
          req.households = households.map((h, i) => ({ ...h, role: memberships[i]?.role || 'member' }));
          req.householdId = raw.h && households.some((h) => h.id === raw.h) ? raw.h : households[0].id;
          req.user = await store.getUserById(null, raw.u);
        }
      }
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

app.post('/api/auth/signup', attachUser, async (req, res) => {
  try {
    const { email, password, name, householdName, joinCode } = req.body || {};
    const r = await store.signUp({ email, password, name, householdName, joinCode });
    let token = null;
    let household = r.household;
    let warning = null;
    if (store.BACKEND === 'supabase') {
      token = r.access_token || r.session?.access_token;
      if (!token) throw new Error('Signup berhasil tapi token tidak diterima');
      const clean = String(joinCode || '').trim();
      if (clean) {
        try {
          household = await store.joinHousehold(token, clean);
        } catch (joinErr) {
          // akun sudah dibuat, jadi jangan tinggalkan user tanpa household
          household = await store.createHousehold(token, householdName || 'Rumah Tangga');
          warning = joinErr.message;
        }
      } else {
        household = await store.createHousehold(token, householdName || 'Rumah Tangga');
      }
    } else {
      await session.createSession(res, r.user);
    }
    res.json({ user: r.user || r.session?.user, household, token, warning, backend: store.BACKEND });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', attachUser, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await store.signIn({ email, password });
    let token = null;
    if (store.BACKEND === 'supabase') {
      token = r.access_token || r.session?.access_token;
    } else {
      await session.createSession(res, r.user);
    }
    const households = await store.listHouseholds(token, r.user.id);
    res.json({ user: r.user || r.session?.user, households, token, backend: store.BACKEND });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  session.clearSession(res);
  res.json({ ok: true });
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
    console.log(`\n  FinNotes v0.2  ->  http://localhost:${PORT}`);
    console.log(`  backend: ${store.BACKEND}\n`);
  });
}

module.exports = app;
