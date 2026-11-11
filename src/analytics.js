'use strict';

const { formatIDR } = require('./parser');

const CAT_COLORS = {
  'Gaji': '#1e6b4e', 'Bonus': '#4a8a5c', 'Pendapatan': '#3e7d8a', 'Refund': '#7d9c6d',
  'Transfer Masuk': '#557d9c', 'Komisi': '#6d8f5e', 'Investasi': '#4a7d74', 'Bantuan': '#9c8f4a',
  'Jualan': '#b3893c', 'Lainnya (Masuk)': '#8c8578',
  'Cicilan': '#9c4a3c', 'Tagihan': '#b3782e', 'Transportasi': '#5f7d8c', 'Kesehatan': '#a84a52',
  'Pendidikan': '#7a5ea0', 'Sosial': '#8f6d55', 'Makan & Minum': '#b3552e', 'Belanja': '#8a6d3b',
  'Hiburan': '#a05a78', 'Bayar': '#6b8f71', 'Tabungan': '#5e7d5a', 'Lainnya': '#8c8578',
};

function colorFor(category, index = 0) {
  if (CAT_COLORS[category]) return CAT_COLORS[category];
  const fallback = ['#8c6d4f', '#5e7d8c', '#a05a78', '#b3782e', '#6d7d5e', '#7a6a8f'];
  let h = 0;
  for (const ch of String(category)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return fallback[h % fallback.length];
}

function rangeFor(period) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (period === 'all') return { from: '0000-01-01', to: today, label: 'Keseluruhan' };
  if (period === 'today') return { from: today, to: today, label: 'Hari Ini' };
  if (period === 'week') {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`, to: today, label: '7 Hari Terakhir' };
  }
  if (period === 'year') {
    const from = new Date(now.getFullYear(), 0, 1);
    return { from: `${now.getFullYear()}-01-01`, to: today, label: `Tahun ${now.getFullYear()}` };
  }
  return {
    from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`,
    to: today,
    label: now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }),
  };
}

async function build(ctx, period = 'month') {
  const { from, to, label } = rangeFor(period);
  const t = ctx.accessToken;
  const h = ctx.householdId;

  const store = ctx.store;
  const [summary, prev, expCats, incCats, daily, totals, members] = await Promise.all([
    store.periodTotals(t, h, from, to),
    store.previousPeriodTotals(t, h, from, to),
    store.topCategories(t, h, 'expense', from, to),
    store.topCategories(t, h, 'income', from, to),
    store.dailySeries(t, h, from, to),
    store.totals(t, h),
    store.listMembers(t, h),
  ]);

  const decorate = (rows, type) => {
    const max = rows.reduce((a, b) => Math.max(a, b.total), 0) || 1;
    return rows.slice(0, 8).map((r, i) => ({
      ...r,
      color: colorFor(r.category, i),
      share: summary.net !== 0 ? 0 : r.total / max,
      pct: max ? Math.round((r.total / max) * 1000) / 10 : 0,
    }));
  };

  const dayMap = new Map(daily.map((d) => [d.date, d]));
  const maxDay = daily.reduce((a, d) => Math.max(a, d.income, d.expense), 0) || 1;

  return {
    period,
    label,
    from,
    to,
    summary: { ...summary, ...{ balance: totals.balance } },
    comparison: prev,
    totals,
    expenseByCategory: decorate(expCats, 'expense'),
    incomeByCategory: decorate(incCats, 'income'),
    series: daily.map((d) => ({
      ...d,
      ...(dayMap.get(d.date) || {}),
      dateHuman: new Date(d.date + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
      incomePct: (d.income / maxDay) * 100,
      expensePct: (d.expense / maxDay) * 100,
    })),
    members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
    formatted: {
      income: formatIDR(summary.income),
      expense: formatIDR(summary.expense),
      balance: formatIDR(totals.balance),
    },
  };
}

module.exports = { build, rangeFor, colorFor, CAT_COLORS };
