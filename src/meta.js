'use strict';

const CATEGORIES = [
  { name: 'Gaji', type: 'income', icon: '💼' },
  { name: 'Bonus', type: 'income', icon: '🎁' },
  { name: 'Pendapatan', type: 'income', icon: '📈' },
  { name: 'Jualan', type: 'income', icon: '🛍️' },
  { name: 'Komisi', type: 'income', icon: '🤝' },
  { name: 'Refund', type: 'income', icon: '↩️' },
  { name: 'Investasi', type: 'income', icon: '📊' },
  { name: 'Bantuan', type: 'income', icon: '🤲' },
  { name: 'Transfer Masuk', type: 'income', icon: '📥' },
  { name: 'Lainnya (Masuk)', type: 'income', icon: '➕' },

  { name: 'Makan & Minum', type: 'expense', icon: '🍽️' },
  { name: 'Transportasi', type: 'expense', icon: '🚗' },
  { name: 'Belanja', type: 'expense', icon: '🛒' },
  { name: 'Tagihan', type: 'expense', icon: '🧾' },
  { name: 'Cicilan', type: 'expense', icon: '📆' },
  { name: 'Kesehatan', type: 'expense', icon: '🩺' },
  { name: 'Pendidikan', type: 'expense', icon: '🎓' },
  { name: 'Hiburan', type: 'expense', icon: '🎮' },
  { name: 'Sosial', type: 'expense', icon: '🕌' },
  { name: 'Bayar', type: 'expense', icon: '💸' },
  { name: 'Tabungan', type: 'expense', icon: '🐖' },
  { name: 'Lainnya', type: 'expense', icon: '📝' },
];

const ICONS = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.icon]));

module.exports = { CATEGORIES, ICONS };
