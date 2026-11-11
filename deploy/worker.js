/**
 * Worker Cloudflare untuk FinNotes.
 *
 * Semua data disimpan di Cloudflare D1 lewat binding DB (wrangler.toml);
 * autentikasi memakai sesi sendiri (bearer token, tabel sessions) — tidak
 * ada lagi service_role atau pihak ketiga.
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
import oidc from '../src/oidc.js';

const { handleMessage, confirmType, formatDate, txCard } = assistant;
const { verifyGoogleIdToken } = oidc;

const store = getStore();
const router = new Router();

/* ---------------- config ---------------- */

router.get('/api/config', (req, reply) => {
  reply({
    backend: 'd1',
    local: false,
    googleClientId: req.env.GOOGLE_CLIENT_ID || null,
  });
});

/* ---------------- auth ---------------- */

router.post('/api/auth/signup', async (req, reply) => {
  try {
    const { email, password, name, householdName, joinCode } = req.body || {};
    const r = await store.signUp({ email, password, name, householdName, joinCode });
    reply({ ...r, backend: 'd1' });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.post('/api/auth/login', async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const r = await store.signIn({ email, password });
    reply({ ...r, backend: 'd1' });
  } catch (e) {
    reply({ error: e.message }, 401);
  }
});

router.post('/api/auth/logout', async (req, reply) => {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  await store.logout(token);
  reply({ ok: true });
});

/**
 * Login "Lanjut dengan Google" (GIS). Frontend mengirim credential (ID
 * token JWT) ke endpoint ini; Worker memverifikasi tanda tangan + klaim
 * lewat JWKS Google, lalu membuat/menghubungkan akun + household
 * server-side. Klien tetap tidak pernah menulis data langsung.
 */
router.post('/api/auth/google', async (req, reply) => {
  try {
    const clientId = req.env.GOOGLE_CLIENT_ID || '';
    const credential = String(req.body?.credential || '').trim();
    const profile = await verifyGoogleIdToken(credential, clientId);
    const r = await store.signInWithGoogle(profile);
    reply({ ...r, backend: 'd1' });
  } catch (e) {
    reply({ error: e.message }, 400);
  }
});

router.get('/api/auth/me', async (req, reply) => {
  await attachUser(req);
  if (!requireAuth(req, reply)) return;
  reply({ user: req.user, households: req.households, backend: 'd1' });
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
      await boot(env);
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
