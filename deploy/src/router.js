/**
 * Router minimal di atas Web Fetch API.
 *
 * Workers tidak punya Express, jadi ini pengganti kecil yang cukup untuk
 * routing yang dipakai aplikasi: pattern dengan :param, wildcard *,
 * query string, dan body JSON.
 */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...CORS, ...headers } });
}

/** "/api/transactions/:id" -> regex + nama grup */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') {
        names.push('wildcard');
        return '(.*)';
      }
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source}/?$`), names };
}

/**
 * Cari route yang cocok. Kalau ada beberapa route dengan pathname sama
 * (mis. PATCH dan DELETE di /api/transactions/:id), utamakan yang method-nya
 * sama supaya tidak salah pilih dan jadi 405.
 */
function match(routes, pathname, method) {
  let pathHit = null;
  for (const r of routes) {
    const m = r.compiled.re.exec(pathname);
    if (!m) continue;
    if (r.method === method) {
      const params = {};
      r.compiled.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    if (!pathHit) pathHit = r;
  }
  return pathHit ? { route: pathHit, methodMismatch: true } : null;
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, compiled: compile(pattern), handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  async handle(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const hit = match(this.routes, url.pathname, request.method);
    if (!hit) return json({ error: 'not found' }, 404);

    if (hit.methodMismatch) {
      return json({ error: 'method not allowed' }, 405, { Allow: 'GET,POST,PATCH,DELETE,OPTIONS' });
    }

    const params = hit.params;

    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const raw = await request.text();
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = null; }
      }
    }

    const query = Object.fromEntries(url.searchParams.entries());

    const req = {
      method: request.method,
      path: url.pathname,
      params,
      query,
      body,
      headers: request.headers,
      request,
      env,
      user: null,
      households: [],
      household: null,
      householdId: null,
      authToken: null,
    };

    // reply(data, status?, headers?) -- string diperlakukan sebagai body teks
    // (dipakai untuk CSV), objek lain sebagai JSON.
    // Respons juga dicatat di `captured` supaya handler boleh memanggil
    // reply(...) tanpa `return`.
    let captured = null;
    const reply = (data, status = 200, headers = {}) => {
      captured = typeof data === 'string' ? text(data, status, headers) : json(data, status, headers);
      return captured;
    };

    const result = await hit.route.handler(req, reply);
    return result || captured || json({ error: 'no response' }, 500);
  }
}
