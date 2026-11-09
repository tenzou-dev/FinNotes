/**
 * Worker Cloudflare untuk Kasir Chat.
 *
 * Semua query memakai token user (bearer), tidak pernah service_role,
 * jadi Row Level Security Supabase tetap berlaku.
 *
 * Aset statis (public/) dilayani lewat binding ASSETS dari [assets]
 * di wrangler.toml, bukan oleh Worker ini.
 */

import { Router, json } from './src/router.js';
import { boot, getStore, EXAMPLES, INCOME, EXPENSE, CATEGORIES } from './src/runtime.js';
import { attachUser, requireAuth, requireHousehold, ctxOf } from './src/auth.js';

import analytics from '../src/analytics.js';
import csv from '../src/csv.js';
import assistant from '../src/assistant.js';

const { handleMessage, confirmType, formatDate, txCard } = assistant;

const store = getStore();
const router = new Router();

/* ---------------- config ---------------- */

router.get('/api/config', (req, reply) => {
  reply({
    backend: 'supabase',
    supabase: { url: req.env.SUPABASE_URL, anonKey: req.env.SUPABASE_ANON_KEY },
  });
});

/* ---------------- auth ---------------- */

router.post('/api/auth/signup', async (req, reply) => {
  try {
    const { email, password, name, householdName, joinCode } = req.body || {};
    const r = await store.signUp({ email, password, name, householdName, joinCode });
    const token = r.access_token || r.session?.access_token;
    if (!token) throw new Error('Signup berhasil tapi token tidak diterima');
    const session = {
      access_token: token,
      refresh_token: r.refresh_token || r.session?.refresh_token || null,
      expires_at: r.expires_at || r.session?.expires_at || Math.floor(Date.now() / 1000) + 3600,
    };

    let warning = null;
    let household = null;
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

    reply({
      user: r.user || r.session?.user,
      household,
      token,
      ...session,
      warning,
      backend: 'supabase',
    });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.post('/api/auth/login', async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const r = await store.signIn({ email, password });
    const token = r.access_token || r.session?.access_token;
    const households = await store.listHouseholds(token, r.user.id);
    reply({
      user: r.user || r.session?.user,
      households,
      token,
      access_token: token,
      refresh_token: r.refresh_token || r.session?.refresh_token || null,
      expires_at: r.expires_at || r.session?.expires_at || Math.floor(Date.now() / 1000) + 3600,
      backend: 'supabase',
    });
  } catch (e) {
    reply({ error: e.message }, 401);
  }
});

router.post('/api/auth/logout', (req, reply) => reply({ ok: true }));

router.get('/api/auth/me', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  reply({ user: req.user, households: req.households, backend: 'supabase' });
});

router.post('/api/households', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  try {
    reply({ household: await store.createHousehold(req.authToken, req.body?.name) });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.post('/api/households/join', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  try {
    reply({ household: await store.joinHousehold(req.authToken, req.body?.code) });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

/* ---------------- data ---------------- */

router.get('/api/state', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const [totals, transactions, messages] = await Promise.all([
      store.totals(ctx.accessToken, ctx.householdId),
      store.listTransactions(ctx.accessToken, ctx.householdId, 500),
      store.lastMessages(ctx.accessToken, ctx.householdId, 60),
    ]);
    reply({
      user: req.user,
      household: req.household,
      totals,
      transactions,
      messages,
      examples: EXAMPLES,
      categories: CATEGORIES,
    });
  } catch (e) {
    reply({ error: e.message }, 500);
  }
});

router.post('/api/chat', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const { text: bodyText, draft, type } = req.body || {};
    let out;
    if (draft && (type === INCOME || type === EXPENSE)) {
      out = await confirmType(ctx, draft, type);
      await store.insertMessage(
        ctx.accessToken, ctx.householdId, ctx.userId, 'user',
        type === INCOME ? `+ ${draft.amount}` : `- ${draft.amount}`, null
      );
    } else {
      if (bodyText === undefined || bodyText === null) {
        reply({ error: 'text required' }, 400);
        return;
      }
      out = await handleMessage(ctx, bodyText);
      await store.insertMessage(ctx.accessToken, ctx.householdId, ctx.userId, 'user', String(bodyText), null);
    }
    await store.insertMessage(ctx.accessToken, ctx.householdId, ctx.userId, 'bot', out.text, out);
    reply({ ...out, totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    console.error('chat error', e.message);
    reply({ error: e.message }, 500);
  }
});

router.patch('/api/transactions/:id', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const patch = { ...(req.body || {}) };
    if (patch.type && ![INCOME, EXPENSE].includes(patch.type)) delete patch.type;
    if (patch.amount != null) patch.amount = Number(patch.amount);
    if (patch.date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) delete patch.date;

    const t = await store.updateTransaction(ctx.accessToken, ctx.householdId, String(req.params.id), patch);
    if (!t) return reply({ error: 'Transaksi tidak ditemukan' }, 404);
    reply({ transaction: txCard(t), totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.delete('/api/transactions/:id', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const ok = await store.deleteTransaction(ctx.accessToken, ctx.householdId, String(req.params.id));
    if (!ok) return reply({ error: 'not found' }, 404);
    reply({ ok: true, totals: await store.totals(ctx.accessToken, ctx.householdId) });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.get('/api/analytics', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    reply(await analytics.build(ctxOf(req), req.query.period || 'month'));
  } catch (e) {
    reply({ error: e.message }, 500);
  }
});

/* ---------------- export ---------------- */

router.get('/api/export/transactions.csv', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const txs = await store.listTransactions(ctx.accessToken, ctx.householdId, 20000);
    reply(csv.transactionsCsv(txs), 200, csv.downloadHeaders(`transaksi-${formatDate(new Date())}.csv`));
  } catch (e) {
    reply({ error: e.message }, 500);
  }
});

router.get('/api/export/summary.csv', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const a = await analytics.build(ctxOf(req), req.query.period || 'month');
    reply(csv.summaryCsv(a), 200, csv.downloadHeaders(`rekap-${a.period}-${a.to}.csv`));
  } catch (e) {
    reply({ error: e.message }, 500);
  }
});

router.get('/api/export/json', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  if (!(await requireHousehold(req, reply))) return;
  try {
    const ctx = ctxOf(req);
    const txs = await store.listTransactions(ctx.accessToken, ctx.householdId, 20000);
    reply(
      {
        exportedAt: new Date().toISOString(),
        household: req.household,
        totals: await store.totals(ctx.accessToken, ctx.householdId),
        transactions: txs,
      },
      200,
      { 'Content-Disposition': `attachment; filename="keuangan-${formatDate(new Date())}.json"` }
    );
  } catch (e) {
    reply({ error: e.message }, 500);
  }
});

/* ---------------- entry ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Aset statis (frontend) dilayani binding ASSETS, bukan Worker.
    // run_worker_first = true di wrangler.toml, jadi kita yang meneruskan.
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Aset belum dikonfigurasi', { status: 404 });
    }

    try {
      boot(env);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
    try {
      return await router.handle(request, env, ctx);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
};
