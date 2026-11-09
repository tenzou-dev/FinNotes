/**
 * Mock Supabase untuk menguji adapter `src/store/supabase.js` tanpa
 * memakai project Supabase sungguhan.
 *
 * Mengimplementasikan bagian yang dipakai aplikasi saja:
 *   - GoTrue   : /auth/v1/signup, /auth/v1/token, /auth/v1/user
 *   - PostgREST: /rest/v1/<table> (select/insert/update/delete + filter,
 *                order, limit, embed) dan /rest/v1/rpc/<fn>
 *
 * RLS sengaja TIDAK disimulasikan. Yang diuji di sini adalah形状 data,
 * bentuk argumen, dan alur bisnis -- bukan keamanan. RLS diuji dengan
 * menjalankan schema.sql di project Supabase asli.
 *
 * Cara pakai:
 *   node deploy/mock-supabase.mjs [port]
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2]) || 54321;
const ANON_KEY = 'test-anon-key';

/* ---------------- data store ---------------- */

const db = {
  authUsers: [],       // id, email, password, user_metadata
  households: [],      // id, name, join_code, currency, created_at
  profiles: [],        // id, email, display_name
  members: [],         // household_id, user_id, role, created_at
  transactions: [],    // id, household_id, user_id, type, amount, category, note, raw, date, created_at
  messages: [],        // id, household_id, user_id, role, text, payload, created_at
  sessions: new Map(), // access_token -> user_id
};

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);

const TABLES = {
  households: db.households,
  profiles: db.profiles,
  household_members: db.members,
  transactions: db.transactions,
  messages: db.messages,
};

function reset() {
  db.authUsers.length = 0;
  db.households.length = 0;
  db.profiles.length = 0;
  db.members.length = 0;
  db.transactions.length = 0;
  db.messages.length = 0;
  db.sessions.clear();
}

/* ---------------- helpers ---------------- */

function send(res, status, body, headers = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

function userFromToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const id = db.sessions.get(m[1]);
  if (!id) return null;
  return db.authUsers.find((u) => u.id === id) || null;
}

/* ---------------- GoTrue ---------------- */

function sessionPayload(user) {
  return {
    access_token: `tok_${user.id}`,
    refresh_token: `ref_${user.id}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: publicUser(user),
  };
}

function publicUser(u) {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: nowIso(),
    user_metadata: u.user_metadata || {},
    app_metadata: {},
    created_at: u.created_at,
  };
}

async function handleAuth(req, res, url) {
  const path = url.pathname.replace(/^\/auth\/v1/, '');

  if (path === '/signup' && req.method === 'POST') {
    const b = await readBody(req);
    const email = String(b?.email || '').trim().toLowerCase();
    const password = String(b?.password || '');
    if (!email.includes('@')) return send(res, 400, { msg: 'invalid email' });
    if (password.length < 6) return send(res, 422, { msg: 'Password should be at least 6 characters' });
    if (db.authUsers.some((u) => u.email === email)) {
      return send(res, 422, { msg: 'User already registered' });
    }
    const user = {
      id: uuid(), email, password,
      user_metadata: b?.data || {},
      created_at: nowIso(),
    };
    db.authUsers.push(user);
    // trigger handle_new_user() di schema.sql membuat baris profiles
    db.profiles.push({
      id: user.id, email,
      display_name: user.user_metadata.display_name || email.split('@')[0],
    });
    db.sessions.set(`tok_${user.id}`, user.id);
    return send(res, 200, sessionPayload(user));
  }

  if (path === '/token' && req.method === 'POST') {
    const b = await readBody(req);
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const id = String(b?.refresh_token || '').replace(/^ref_/, '');
      const user = db.authUsers.find((u) => u.id === id);
      if (!user) return send(res, 400, { error: 'invalid_grant' });
      db.sessions.set(`tok_${user.id}`, user.id);
      return send(res, 200, sessionPayload(user));
    }
    const email = String(b?.email || '').trim().toLowerCase();
    const user = db.authUsers.find((u) => u.email === email && u.password === b?.password);
    if (!user) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    db.sessions.set(`tok_${user.id}`, user.id);
    return send(res, 200, sessionPayload(user));
  }

  if (path === '/user' && req.method === 'GET') {
    const user = userFromToken(req);
    if (!user) return send(res, 401, { msg: 'invalid token' });
    return send(res, 200, publicUser(user));
  }

  return send(res, 404, { msg: 'not found' });
}

/* ---------------- PostgREST mini ---------------- */

/**
 * PostgREST menaruh filter di VALUE, bukan key:
 *   ?household_id=eq.abc&date=gte.2026-01-01&id=in.(a,b)
 * URLSearchParams sudah memecahnya jadi (key=household_id, value='eq.abc').
 */
const RESERVED_QUERY_KEYS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function parseFilters(search) {
  const out = [];
  for (const [col, raw] of search.entries()) {
    if (RESERVED_QUERY_KEYS.has(col)) continue;

    // "is.null" / "is.not_null"
    const isNull = /^is\.(not_null|null)$/.exec(raw);
    if (isNull) {
      out.push({ col, op: isNull[1] === 'null' ? 'is_null' : 'is_not_null', value: null });
      continue;
    }

    const m = /^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.*)$/s.exec(raw);
    if (!m) { out.push({ col, op: 'eq', value: raw }); continue; }

    const op = m[1];
    let value = m[2];
    if (op === 'in') {
      value = value.replace(/^\(|\)$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
    } else if (/^".*"$/.test(value)) {
      value = value.slice(1, -1);
    }
    out.push({ col, op, value });
  }
  return out;
}

function applyFilters(rows, filters) {
  let out = rows;
  for (const f of filters) {
    out = out.filter((row) => {
      const v = row[f.col];
      switch (f.op) {
        case 'eq': return String(v) === String(f.value);
        case 'neq': return String(v) !== String(f.value);
        case 'gt': return v > f.value;
        case 'gte': return v >= f.value;
        case 'lt': return v < f.value;
        case 'lte': return v <= f.value;
        case 'like': return new RegExp(f.value.replace(/%/g, '.*')).test(String(v));
        case 'ilike': return new RegExp(f.value.replace(/%/g, '.*'), 'i').test(String(v));
        case 'in': return f.value.map(String).includes(String(v));
        case 'is_null': return v === null || v === undefined;
        case 'is_not_null': return v !== null && v !== undefined;
        default: return true;
      }
    });
  }
  return out;
}

function applyOrder(rows, orderSpec) {
  if (!orderSpec) return rows;
  const parts = orderSpec.split(',').map((s) => {
    const [col, dir] = s.split('.');
    return { col, desc: dir === 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const p of parts) {
      const av = a[p.col];
      const bv = b[p.col];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return p.desc ? -cmp : cmp;
    }
    return 0;
  });
}

/** select="*,profiles:user_id(display_name)" -> bentuk respons */
function applySelect(rows, selectSpec) {
  if (!selectSpec || selectSpec === '*') return rows;
  const embeds = [];
  const cols = [];

  // pisahkan bagian embed ("alias:col(...)") dari kolom biasa
  const re = /([A-Za-z0-9_]+):([A-Za-z0-9_]+)\(([^)]*)\)/g;
  let rest = selectSpec;
  let m;
  while ((m = re.exec(selectSpec))) {
    embeds.push({ alias: m[1], fk: m[2], cols: m[3].split(',') });
    rest = rest.replace(m[0], '');
  }

  for (const c of rest.split(',')) {
    const col = c.trim();
    if (col && col !== '*') cols.push(col);
  }

  const out = rows.map((row) => {
    const o = { ...row };
    for (const e of embeds) {
      const target = TABLES[e.alias];
      const fkValue = row[e.fk];
      const match = target ? target.find((t) => t.id === fkValue) : null;
      o[e.alias] = match ? Object.fromEntries(e.cols.map((c) => [c, match[c]])) : null;
    }
    return o;
  });

  return out;
}

function wantRepresentation(req) {
  const prefer = req.headers.prefer || '';
  return /return=representation/i.test(prefer);
}

function wantsSingleObject(req) {
  const accept = req.headers.accept || '';
  return /vnd\.pgrst\.object\+json/i.test(accept);
}

function sendRows(res, rows, req) {
  if (wantsSingleObject(req)) {
    if (!rows.length) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
    return send(res, 200, rows[0]);
  }
  return send(res, 200, rows);
}

async function handleRest(req, res, url) {
  const m = /^\/rest\/v1\/([^/?]+)/.exec(url.pathname);
  if (!m) return send(res, 404, { message: 'not found' });
  const name = m[1];

  /* ---- RPC ---- */
  if (name === 'rpc') {
    const fn = decodeURIComponent(url.pathname.split('/').pop());
    const b = (await readBody(req)) || {};
    const user = userFromToken(req);
    const uid = user?.id;
    if (!uid) return send(res, 401, { message: 'JWT required' });

    if (fn === 'setup_my_household') {
      let existing = db.members.filter((x) => x.user_id === uid);
      if (existing.length) {
        const h = db.households.find((x) => x.id === existing[0].household_id);
        return send(res, 200, h);
      }
      let code;
      do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
      } while (db.households.some((h) => h.join_code === code));
      const h = {
        id: uuid(),
        name: (b.household_name || '').trim() || 'Rumah Tangga',
        join_code: code, currency: 'IDR', created_at: nowIso(),
      };
      db.households.push(h);
      db.members.push({ household_id: h.id, user_id: uid, role: 'owner', created_at: nowIso() });
      return send(res, 200, h);
    }

    if (fn === 'join_household') {
      const code = String(b.code || '').trim().toUpperCase();
      const h = db.households.find((x) => x.join_code === code);
      if (!h) return send(res, 400, { message: 'Kode undangan tidak ditemukan' });
      if (!db.members.some((x) => x.household_id === h.id && x.user_id === uid)) {
        db.members.push({ household_id: h.id, user_id: uid, role: 'member', created_at: nowIso() });
      }
      return send(res, 200, h);
    }

    return send(res, 404, { message: `function ${fn} not found` });
  }

  /* ---- table ---- */
  const table = TABLES[name];
  if (!table) return send(res, 404, { message: `relation "${name}" does not exist` });

  const filters = parseFilters(url.searchParams);
  const orderSpec = url.searchParams.get('order');
  const limit = Number(url.searchParams.get('limit')) || null;
  const selectSpec = url.searchParams.get('select');

  if (req.method === 'GET') {
    let rows = applyFilters(table, filters);
    rows = applyOrder(rows, orderSpec);
    if (limit) rows = rows.slice(0, limit);
    rows = applySelect(rows, selectSpec);
    return sendRows(res, rows, req);
  }

  const body = await readBody(req);
  const payload = Array.isArray(body) ? body : [body];

  if (req.method === 'POST') {
    const created = payload.map((p) => withDefaults(name, p));
    table.push(...created);
    if (wantRepresentation(req)) {
      return sendRows(res, applySelect(created, selectSpec), req);
    }
    return send(res, 201, created.map((c) => ({ id: c.id })));
  }

  if (req.method === 'PATCH') {
    const matched = applyFilters(table, filters);
    for (const row of matched) {
      for (const p of payload) {
        if (p && typeof p === 'object') Object.assign(row, p);
      }
    }
    if (wantRepresentation(req)) {
      return sendRows(res, applySelect(matched, selectSpec), req);
    }
    return send(res, 200, matched.map((r) => ({ id: r.id })));
  }

  if (req.method === 'DELETE') {
    const matched = applyFilters(table, filters);
    for (const row of matched) {
      const i = table.indexOf(row);
      if (i >= 0) table.splice(i, 1);
    }
    if (wantRepresentation(req)) return send(res, 200, matched.map((r) => ({ id: r.id })));
    res.writeHead(204);
    return res.end();
  }

  return send(res, 405, { message: 'method not allowed' });
}

function withDefaults(table, p) {
  const id = uuid();
  const base = { id, created_at: nowIso() };
  if (table === 'transactions') {
    return { ...base, amount: 0, note: '', raw: null, date: todayIso(), ...p, amount: Number(p.amount) };
  }
  if (table === 'messages') return { ...base, ...p, payload: p.payload ?? null };
  if (table === 'households') return { ...base, currency: 'IDR', ...p };
  return { ...base, ...p };
}

/* ---------------- server ---------------- */

export function createMockSupabase() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url);
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
      return send(res, 404, { msg: 'not found' });
    } catch (e) {
      return send(res, 500, { message: e.message, stack: e.stack });
    }
  });
}

// dijalankan langsung: node deploy/mock-supabase.mjs 54321
if (process.argv[1] && process.argv[1].endsWith('mock-supabase.mjs')) {
  const server = createMockSupabase();
  server.listen(PORT, () => {
    console.log(`mock supabase  ->  http://localhost:${PORT}`);
    console.log(`anon key       ->  ${ANON_KEY}`);
  });
}

export { ANON_KEY, reset, db, PORT };
