'use strict';

const { createClient } = require('@supabase/supabase-js');

// Diisi dari process.env (Node) atau lewat configure() (Cloudflare Worker).
let SUPA_URL = process.env.SUPABASE_URL;
let ANON_KEY = process.env.SUPABASE_ANON_KEY;

function configure({ url, anonKey }) {
  if (url) SUPA_URL = url;
  if (anonKey) ANON_KEY = anonKey;
}

function client(accessToken) {
  if (!SUPA_URL || !ANON_KEY) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY belum di-set');
  return createClient(SUPA_URL, ANON_KEY, {
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function unwrap({ data, error }, ctx) {
  if (error) throw new Error(`${error.message}${ctx ? ' (' + ctx + ')' : ''}`);
  return data;
}

async function signUp({ email, password, name, joinCode }) {
  const clean = String(email || '').trim().toLowerCase();
  const sb = client();
  const { data, error } = await sb.auth.signUp({
    email: clean,
    password,
    options: { data: { display_name: name || clean.split('@')[0] } },
  });
  if (error) throw new Error(mapAuthError(error.message));
  if (!data.session) throw new Error('Konfirmasi email diperlukan sebelum bisa masuk');
  return data.session;
}

async function signIn({ email, password }) {
  const sb = client();
  const { data, error } = await sb.auth.signInWithPassword({ email: String(email || '').trim().toLowerCase(), password });
  if (error) throw new Error(mapAuthError(error.message));
  return data.session;
}

function mapAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return 'Email atau password salah';
  if (/already registered/i.test(msg)) return 'Email sudah terdaftar';
  if (/password should be at least/i.test(msg)) return 'Password minimal 6 karakter';
  if (/email not confirmed/i.test(msg)) return 'Email belum dikonfirmasi, cek inbox dulu';
  // Project paused (HTTP 540): edge Supabase menjawab tanpa pesan, supabase-js
  // meneruskannya sebagai "<none>". fetch gagal total muncul sebagai
  // "fetch failed" (Node) atau "internal error; reference = ..." (workerd).
  const unreachable = /^<none>$/i.test(String(msg).trim())
    || /fetch failed|failed to fetch|load failed/i.test(msg)
    || /internal error; reference/i.test(msg)
    || /network|ENOTFOUND|ECONNREFUSED/i.test(msg);
  if (unreachable) {
    return 'Tidak bisa menghubungi Supabase. Cek apakah project aktif (project free tier bisa di-pause) di supabase.com/dashboard.';
  }
  return msg;
}

async function getUserFromToken(accessToken) {
  const sb = client(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}

async function ensureProfile(sb, user) {
  const name = user.user_metadata?.display_name || (user.email || '').split('@')[0];
  const existing = unwrap(
    await sb.from('profiles').select('id, display_name, email').eq('id', user.id).maybeSingle(),
    'profile'
  );
  if (existing) return existing;
  unwrap(
    await sb.from('profiles').insert({ id: user.id, email: user.email, display_name: name }),
    'profile insert'
  );
  return { id: user.id, display_name: name, email: user.email };
}

async function getSession(accessToken) {
  if (!accessToken) return null;
  const user = await getUserFromToken(accessToken);
  if (!user) return null;
  const sb = client(accessToken);
  const profile = await ensureProfile(sb, user);
  const households = await listHouseholds(accessToken, user.id);
  return {
    user: { id: user.id, email: user.email, name: profile.display_name || user.email },
    households,
  };
}

async function listHouseholds(accessToken, userId) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('household_members').select('household_id, role').eq('user_id', userId),
    'members'
  );
  if (!rows?.length) return [];
  const ids = rows.map((r) => r.household_id);
  const hs = unwrap(await sb.from('households').select('*').in('id', ids), 'households');
  return (hs || []).map((h) => ({ ...h, role: rows.find((r) => r.household_id === h.id)?.role || 'member' }));
}

async function setupHousehold(accessToken, name) {
  const sb = client(accessToken);
  await ensureProfile(sb, await getUserFromToken(accessToken));
  return unwrap(await sb.rpc('setup_my_household', { household_name: name || 'Rumah Tangga' }), 'setup');
}

async function joinHousehold(accessToken, code) {
  const sb = client(accessToken);
  const { data, error } = await sb.rpc('join_household', { code: String(code || '').trim().toUpperCase() });
  if (error) {
    if (/tidak ditemukan/i.test(error.message)) throw new Error('Kode undangan tidak ditemukan');
    throw new Error(error.message);
  }
  return data;
}

async function getMembership(accessToken, userId, householdId) {
  const rows = unwrap(
    await sb_(accessToken).from('household_members').select('role').eq('household_id', householdId).eq('user_id', userId),
    'membership'
  );
  const m = (rows || [])[0];
  if (!m) throw new Error('Akses ditolak');
  return m;
}
const sb_ = (t) => client(t);

async function listMembers(accessToken, householdId) {
  const sb = client(accessToken);
  const rows = unwrap(await sb.from('household_members').select('user_id, role').eq('household_id', householdId), 'members');
  if (!rows?.length) return [];
  const users = unwrap(await sb.from('profiles').select('id, email, display_name').in('id', rows.map((r) => r.user_id)), 'profiles');
  return rows.map((r) => {
    const u = (users || []).find((x) => x.id === r.user_id);
    return { id: r.user_id, email: u?.email, name: u?.display_name || u?.email || '?', role: r.role };
  });
}

async function getUserById(accessToken, id) {
  const sb = client(accessToken);
  const r = unwrap(await sb.from('profiles').select('id, email, display_name').eq('id', id).maybeSingle(), 'profile');
  if (!r) return null;
  return { id: r.id, email: r.email, name: r.display_name || r.email };
}

async function getHousehold(accessToken, id) {
  const sb = client(accessToken);
  const r = unwrap(await sb.from('households').select('*').eq('id', id).maybeSingle(), 'household');
  return r || null;
}

const txRow = (t) => ({
  id: t.id, type: t.type, amount: Number(t.amount), category: t.category, note: t.note || '',
  raw: t.raw, date: t.date, authorId: t.user_id, author: t.author_name || null, createdAt: t.created_at,
});

async function insertTransaction(accessToken, householdId, userId, tx) {
  const sb = client(accessToken);
  const row = {
    household_id: householdId, user_id: userId, type: tx.type,
    amount: Math.round(tx.amount), category: tx.category, note: tx.note,
    raw: tx.raw || null, date: tx.date,
  };
  const res = unwrap(
    await sb.from('transactions').insert(row).select('*, profiles:user_id(display_name)').single(),
    'insert tx'
  );
  return txRow({ ...res, author_name: res.profiles?.display_name || null });
}

async function listTransactions(accessToken, householdId, limit) {
  const sb = client(accessToken);
  let q = sb.from('transactions').select('*, profiles:user_id(display_name)').eq('household_id', householdId)
    .order('date', { ascending: false }).order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);
  const rows = unwrap(await q, 'list tx');
  return (rows || []).map((r) => txRow({ ...r, author_name: r.profiles?.display_name || null }));
}

async function getTransaction(accessToken, householdId, id) {
  const sb = client(accessToken);
  const r = unwrap(await sb.from('transactions').select('*').eq('household_id', householdId).eq('id', id).maybeSingle(), 'get tx');
  return r ? txRow(r) : null;
}

async function updateTransaction(accessToken, householdId, id, patch) {
  const sb = client(accessToken);
  const body = {};
  if (patch.type) body.type = patch.type;
  if (patch.amount) body.amount = Math.round(patch.amount);
  if (patch.category != null) body.category = patch.category;
  if (patch.note != null) body.note = patch.note;
  if (patch.date) body.date = patch.date;
  const r = unwrap(
    await sb.from('transactions').update(body).eq('household_id', householdId).eq('id', id)
      .select('*, profiles:user_id(display_name)').single(),
    'update tx'
  );
  return txRow({ ...r, author_name: r.profiles?.display_name || null });
}

async function deleteTransaction(accessToken, householdId, id) {
  const sb = client(accessToken);
  const r = unwrap(await sb.from('transactions').delete().eq('household_id', householdId).eq('id', id).select('id'), 'delete tx');
  return (r || []).length > 0;
}

async function deleteAllTransactions(accessToken, householdId) {
  const sb = client(accessToken);
  const r = unwrap(await sb.from('transactions').delete().eq('household_id', householdId).select('id'), 'clear tx');
  return (r || []).length;
}

async function lastTransaction(accessToken, householdId) {
  const sb = client(accessToken);
  const r = unwrap(
    await sb.from('transactions').select('*').eq('household_id', householdId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    'last tx'
  );
  return r ? txRow(r) : null;
}

async function totals(accessToken, householdId) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('transactions').select('type, amount').eq('household_id', householdId).limit(10000),
    'totals'
  );
  let income = 0, expense = 0;
  for (const r of rows || []) (r.type === 'income' ? (income += Number(r.amount)) : (expense += Number(r.amount)));
  return { income, expense, balance: income - expense, count: (rows || []).length };
}

async function rangeAgg(accessToken, householdId, from, to) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('transactions').select('type, amount').eq('household_id', householdId)
      .gte('date', from).lte('date', to).limit(10000),
    'range'
  );
  let income = 0, expense = 0;
  for (const r of rows || []) (r.type === 'income' ? (income += Number(r.amount)) : (expense += Number(r.amount)));
  return { income, expense, net: income - expense, count: (rows || []).length };
}

async function periodTotals(accessToken, householdId, from, to) {
  const r = await rangeAgg(accessToken, householdId, from, to);
  return { ...r, from, to };
}

function prevBounds(from, to) {
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to + 'T00:00:00');
  const span = Math.round((t - f) / 86400000) + 1;
  const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - span + 1);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

async function previousPeriodTotals(accessToken, householdId, from, to) {
  if (from < '2000-01-01') {
    return { income: 0, expense: 0, count: 0, from: null, to: null, available: false };
  }
  const b = prevBounds(from, to);
  return { ...(await rangeAgg(accessToken, householdId, b.from, b.to)), ...b, available: true };
}

async function topCategories(accessToken, householdId, type, from, to) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('transactions').select('category, amount').eq('household_id', householdId)
      .eq('type', type).gte('date', from).lte('date', to).limit(10000),
    'top cats'
  );
  const map = new Map();
  for (const r of rows || []) {
    const e = map.get(r.category) || { category: r.category, type, total: 0, count: 0 };
    e.total += Number(r.amount); e.count++;
    map.set(r.category, e);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

async function dailySeries(accessToken, householdId, from, to) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('transactions').select('date, type, amount').eq('household_id', householdId)
      .gte('date', from).lte('date', to).order('date').limit(10000),
    'daily'
  );
  const map = new Map();
  for (const r of rows || []) {
    const e = map.get(r.date) || { date: r.date, income: 0, expense: 0 };
    if (r.type === 'income') e.income += Number(r.amount); else e.expense += Number(r.amount);
    map.set(r.date, e);
  }
  return [...map.values()];
}

async function activeDays(accessToken, householdId, limit = 30) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('transactions').select('date').eq('household_id', householdId)
      .order('date', { ascending: false }).limit(limit),
    'active days'
  );
  return [...new Set((rows || []).map((r) => r.date))];
}

async function insertMessage(accessToken, householdId, userId, role, text, payload) {
  const sb = client(accessToken);
  const r = unwrap(
    await sb.from('messages').insert({
      household_id: householdId, user_id: userId, role, text, payload: payload || null,
    }).select('id').single(),
    'insert msg'
  );
  return r;
}

async function lastMessages(accessToken, householdId, limit = 50) {
  const sb = client(accessToken);
  const rows = unwrap(
    await sb.from('messages').select('*').eq('household_id', householdId)
      .order('created_at', { ascending: false }).limit(limit),
    'last msgs'
  );
  return (rows || []).reverse().map((m) => ({
    id: m.id, role: m.role, text: m.text, payload: m.payload, createdAt: m.created_at,
  }));
}

module.exports = {
  BACKEND: 'supabase',
  isAsync: true,
  configure,
  signUp, signIn, getUserFromToken, getSession,
  // nama seragam dengan store/index.js; implementasi sama (RPC)
  createHousehold: setupHousehold,
  joinHousehold,
  listHouseholds, getMembership, listMembers, getUserById, getHousehold,
  insertTransaction, listTransactions, getTransaction, updateTransaction, deleteTransaction,
  deleteAllTransactions, deleteLastTransaction: lastTransaction,
  totals, periodTotals, previousPeriodTotals, topCategories, dailySeries, activeDays,
  insertMessage, lastMessages,
};
