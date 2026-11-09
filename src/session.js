'use strict';

const crypto = require('node:crypto');
const store = require('./store');

const SESSION_COOKIE = 'kj_session';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function createSession(res, user) {
  if (store.IS_ASYNC) {
    return null;
  }
  const token = makeToken();
  res.cookie(SESSION_COOKIE, JSON.stringify({ u: user.id, t: token }), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  return token;
}

function readSession(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE);
}

module.exports = { SESSION_COOKIE, createSession, readSession, clearSession, makeToken };
