'use strict';

const { detectBackend } = require('../config');
const sqlite = require('./sqlite');
const supabase = require('./supabase');

const MODE = detectBackend();
const impl = MODE === 'supabase' ? supabase : sqlite;

const wrap = (fn) => async (...args) => fn(...args);

const DATA_METHODS = [
  'listHouseholds', 'getMembership', 'listMembers',
  'getUserById', 'getHousehold', 'createHousehold', 'joinHousehold',
  'insertTransaction', 'listTransactions', 'getTransaction', 'updateTransaction',
  'deleteTransaction', 'deleteLastTransaction', 'deleteAllTransactions',
  'totals', 'periodTotals', 'previousPeriodTotals', 'topCategories',
  'dailySeries', 'activeDays', 'insertMessage', 'lastMessages',
];

const store = { BACKEND: MODE, IS_ASYNC: MODE === 'supabase' };

for (const m of DATA_METHODS) {
  store[m] = MODE === 'supabase' ? impl[m] : wrap(impl[m]);
}

if (MODE === 'sqlite') {
  // SQLite lokal tidak punya konsep join code antar user.
  store.joinHousehold = () => {
    throw new Error('Gabung lewat kode hanya tersedia di mode Supabase');
  };
}

if (MODE === 'supabase') {
  store.signUp = supabase.signUp;
  store.signIn = supabase.signIn;
  store.getSession = supabase.getSession;
} else {
  store.signUp = async ({ email, password, name, householdName, joinCode }) => {
    const { user, household } = sqlite.createUser({ email, password, name, householdName, joinCode });
    return { user, household };
  };
  store.signIn = async ({ email, password }) => ({ user: sqlite.login({ email, password }) });
  store.getSession = async () => null;
}

module.exports = store;
