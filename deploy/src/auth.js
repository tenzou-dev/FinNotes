import { getStore } from './runtime.js';

const store = getStore();

export async function attachUser(req) {
  const h = req.headers.get('authorization');
  const token = h && h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return;
  try {
    const s = await store.getSession(token);
    if (!s) return;
    req.authToken = token;
    req.user = s.user;
    req.households = s.households || [];
  } catch (e) {
    console.error('auth error', e.message);
  }
}

export function requireAuth(req, reply) {
  if (!req.user) {
    reply({ error: 'Belum login' }, 401);
    return false;
  }
  return true;
}

export async function requireHousehold(req, reply) {
  const id = req.query.household || req.body?.householdId || req.householdId || req.households?.[0]?.id;
  if (!id) {
    reply({ error: 'Belum ada household' }, 400);
    return false;
  }
  try {
    await store.getMembership(req.authToken, req.user.id, id);
  } catch (e) {
    reply({ error: e.message }, 403);
    return false;
  }
  req.householdId = id;
  req.household = req.households.find((x) => x.id === id) || (await store.getHousehold(req.authToken, id));
  return true;
}

export function ctxOf(req) {
  return {
    store,
    accessToken: req.authToken || null,
    householdId: req.householdId,
    userId: req.user.id,
    displayName: req.user.name,
  };
}
