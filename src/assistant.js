'use strict';

// store diambil dari ctx.store supaya modul ini tidak terikat ke
// SQLite maupun Supabase (dipakai juga oleh Cloudflare Worker).
const { parseMany } = require('./splitter');
const { INCOME, EXPENSE, EXAMPLES, parse, formatIDR } = require('./parser');

const HELP = [
  'gaji 1jt',
  'bayar angsuran 350rb',
  'kopi 25k',
  'bonus 2,5jt',
  'jualan kue 450rb',
  'listrik 320rb kemarin',
  'nabung 500rb',
  '+ 50rb  /  - 50rb',
  'beli nasi 25rb sama kopi 15rb',
  'rekap bulan ini',
  'hapus terakhir',
  'hapus semua',
];

const Q = {
  noAmount: 'Hmm, nominalnya belum kebaca. Coba tulis lengkap, contoh: "bayar bensin 50rb" atau "gaji 1jt".',
  noType: 'Nominal {amount} udah kebaca, tapi aku belum tahu ini pemasukan atau pengeluaran. Tolong pilih ya:',
  cancelled: 'Oke, dibatalkan. Tidak ada transaksi yang dicatat.',
  empty: 'Boleh tulis apa aja, ketik "bantu" kalau mau lihat contoh.',
};

const CANCEL_RE = /^\s*(?:batal|no|nanti|gak|nggak|skip|undo)\s*$/i;

const pad = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => formatDate(new Date());
const monthStart = () => {
  const n = new Date();
  return formatDate(new Date(n.getFullYear(), n.getMonth(), 1));
};

function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (iso === today()) return 'hari ini';
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (iso === formatDate(yest)) return 'kemarin';
  return dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

const sign = (t) => (t === INCOME ? '+' : '-');

function txCard(tx) {
  return {
    id: tx.id,
    type: tx.type,
    amount: tx.amount,
    amountFormatted: formatIDR(tx.amount),
    signed: sign(tx.type) + formatIDR(tx.amount),
    category: tx.category,
    note: tx.note,
    date: tx.date,
    dateHuman: humanDate(tx.date),
    author: tx.author || null,
    authorId: tx.authorId || null,
  };
}

const reply = (text, extra = {}) => ({ text, ...extra });

async function save(ctx, item) {
  return ctx.store.insertTransaction(ctx.accessToken, ctx.householdId, ctx.userId, item);
}

async function balanceLine(ctx) {
  const t = await ctx.store.totals(ctx.accessToken, ctx.householdId);
  return `Saldo sekarang ${formatIDR(t.balance)}`;
}

async function handleMessage(ctx, rawText) {
  const text = String(rawText || '').trim();

  if (!text) return reply(Q.empty);
  if (CANCEL_RE.test(text)) return reply(Q.cancelled);

  const lower = text.toLowerCase();

  if (/^(bantu|help|bantuan|contoh|menu|caranya|gimana)\b/.test(lower)) {
    return reply(
      'Gini caranya. Tulis transaksi natural, aku yang nebak jenis & nominalnya:\n\n' +
        HELP.map((h) => '- ' + h).join('\n') +
        '\n\nSatu chat bisa beberapa transaksi: "beli nasi 25rb sama kopi 15rb".\n' +
        'Tanda + / - kalau mau memastikan jenisnya.'
    );
  }

  if (/^(rekap|ringkasan|summary|laporan|total|statistik)\b/.test(lower)) {
    return rekap(ctx, lower);
  }

  if (/^hapus\s+(semua|all)\b/.test(lower) || /^reset\b/.test(lower)) {
    const n = await ctx.store.deleteAllTransactions(ctx.accessToken, ctx.householdId);
    if (!n) return reply('Tidak ada transaksi untuk dihapus.');
    return reply(`Semua ${n} transaksi sudah dihapus. Saldo kembali Rp0.`, { cleared: n });
  }

  if (/^hapus\s+(terakhir|last|akhirnya)\b/.test(lower) || /^(undo|batik|batalin)\b/.test(lower)) {
    const removed = await ctx.store.deleteLastTransaction(ctx.accessToken, ctx.householdId);
    if (!removed) return reply('Belum ada transaksi yang bisa dihapus.');
    return reply(
      `Terhapus: ${sign(removed.type)}${formatIDR(removed.amount)} - ${removed.category}.\n` + (await balanceLine(ctx)),
      { removed: { ...txCard(removed), deleted: true } }
    );
  }

  if (/^hapus\b/.test(lower)) {
    return reply('Mau hapus yang mana? Coba: "hapus terakhir" atau "hapus semua".');
  }

  const forceType = /^\s*\+/.test(text) ? INCOME : /^\s*-/.test(text) ? EXPENSE : null;
  const result = parseMany(text, { forceType });

  if (!result.items.length) {
    return reply(Q.noAmount, { examples: EXAMPLES.slice(0, 3) });
  }

  const ready = result.items.filter((i) => i.type);

  if (!ready.length) {
    const first = result.items[0];
    return reply(Q.noType.replace('{amount}', formatIDR(first.amount)), {
      needsType: true,
      draft: draftFrom(first),
    });
  }

  const saved = [];
  for (const item of ready) {
    if (item.needsType) {
      return reply(Q.noType.replace('{amount}', formatIDR(item.amount)), {
        needsType: true, draft: draftFrom(item), partial: saved.map(txCard),
      });
    }
    saved.push(await save(ctx, item));
  }

  const totals = await ctx.store.totals(ctx.accessToken, ctx.householdId);

  if (saved.length === 1) {
    const tx = saved[0];
    const label = tx.type === INCOME ? 'Pemasukan' : 'Pengeluaran';
    const author = tx.author && ctx.displayName && tx.author !== ctx.displayName ? ` (dari ${tx.author})` : '';
    return reply(
      `Oke, dicatat sebagai ${label} ${formatIDR(tx.amount)}\n` +
        `Kategori: ${tx.category} | ${humanDate(tx.date)}${author}\n` +
        `Saldo sekarang ${formatIDR(totals.balance)}`,
      { transaction: txCard(saved[0]) }
    );
  }

  const lines = saved.map((tx) => `${sign(tx.type)}${formatIDR(tx.amount)}  ${tx.category} (${tx.note})`);
  return reply(
    `Oke, ${saved.length} transaksi tercatat:\n${lines.join('\n')}\n` +
      `Saldo sekarang ${formatIDR(totals.balance)}`,
    { transactions: saved.map(txCard) }
  );
}

function draftFrom(item) {
  return {
    amount: item.amount,
    amountFormatted: formatIDR(item.amount),
    note: item.note,
    date: item.date,
    dateHuman: humanDate(item.date),
  };
}

async function confirmType(ctx, draft, type) {
  const result = parse(`${type === INCOME ? '+' : '-'} ${draft.amount}`, { forceType: type });
  if (draft.note) result.note = draft.note;
  if (draft.date) result.date = draft.date;
  const saved = await save(ctx, result);
  const label = type === INCOME ? 'Pemasukan' : 'Pengeluaran';
  return reply(
    `Sip, ${label} ${formatIDR(result.amount)} - ${result.category} tercatat.\n` + (await balanceLine(ctx)),
    { transaction: txCard(saved) }
  );
}

async function rekap(ctx, lower) {
  const isAll = /\b(semua|all|keseluruhan|total keseluruhan)\b/.test(lower);
  const from = isAll ? '0000-01-01' : monthStart();
  const to = today();
  const p = await ctx.store.periodTotals(ctx.accessToken, ctx.householdId, from, to);
  const totals = await ctx.store.totals(ctx.accessToken, ctx.householdId);

  let text =
    `Rekap ${isAll ? 'keseluruhan' : 'bulan ini'} (${p.count} transaksi)\n` +
    `Pemasukan: ${formatIDR(p.income)}\n` +
    `Pengeluaran: ${formatIDR(p.expense)}\n` +
    `Selisih: ${sign(p.net >= 0 ? INCOME : EXPENSE)}${formatIDR(p.net)}\n`;

  const cats = await ctx.store.topCategories(ctx.accessToken, ctx.householdId, EXPENSE, from, to);
  if (cats.length) {
    text += '\nPengeluaran terbesar:\n' + cats.slice(0, 3).map((c) => `- ${c.category}: ${formatIDR(c.total)}`).join('\n');
  }
  text += `\n\nSaldo total ${formatIDR(totals.balance)}.`;
  return reply(text, { rekap: { ...p, scope: isAll ? 'all' : 'month' } });
}

module.exports = { handleMessage, confirmType, formatDate, humanDate, txCard, HELP };