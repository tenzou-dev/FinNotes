'use strict';

const { formatIDR } = require('./parser');

const CAT_COLORS = {
  'Gaji': '#00a884', 'Bonus': '#53bdeb', 'Pendapatan': '#7c8ef5', 'Refund': '#4dd0c1',
  'Transfer Masuk': '#5ac8fa', 'Komisi': '#8bc34a', 'Investasi': '#26a69a', 'Bantuan': '#7cb342',
  'Jualan': '#ffb02e', 'Lainnya (Masuk)': '#78909c',
  'Cicilan': '#f15c6d', 'Tagihan': '#ef5350', 'Transportasi': '#ff7043', 'Kesehatan': '#ec407a',
  'Pendidikan': '#ab47bc', 'Sosial': '#8d6e63', 'Makan & Minum': '#ffa726', 'Belanja': '#ffca28',
  'Hiburan': '#ba68c8', 'Bayar': '#f06292', 'Tabungan': '#66bb6a', 'Lainnya': '#90a4ae',
};

function colorFor(category, index = 0) {
  if (CAT_COLORS[category]) return CAT_COLORS[category];
  const fallback = ['#4db6ac', '#7986cb', '#e57373', '#ffd54f', '#a1887f', '#90caf9'];
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
