'use strict';

const { formatIDR } = require('./parser');

const TYPE_LABEL = { income: 'Pemasukan', expense: 'Pengeluaran' };

function cell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

function transactionsCsv(transactions) {
  const rows = [
    ['Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Nominal', 'Dicatat Oleh', 'Chat Asal'],
  ];
  for (const t of transactions) {
    rows.push([
      t.date,
      TYPE_LABEL[t.type] || t.type,
      t.category,
      t.note,
      (t.type === 'income' ? '' : '-') + t.amount,
      t.author || '-',
      t.raw || '',
    ]);
  }
  return toCsv(rows);
}

function summaryCsv(a) {
  const rows = [['Rekap Keuangan'], ['Periode', a.label], ['Dari', a.from], ['Sampai', a.to], []];
  rows.push(['Ringkasan', 'Jumlah']);
  rows.push(['Pemasukan', a.summary.income]);
  rows.push(['Pengeluaran', a.summary.expense]);
  rows.push(['Saldo periode', a.summary.net]);
  rows.push(['Saldo keseluruhan', a.totals.balance]);
  rows.push(['Jumlah transaksi', a.summary.count]);
  rows.push([]);

  rows.push(['Pengeluaran per Kategori', 'Jumlah', 'Transaksi']);
  for (const c of a.expenseByCategory) rows.push([c.category, c.total, c.count]);
  rows.push([]);

  rows.push(['Pemasukan per Kategori', 'Jumlah', 'Transaksi']);
  for (const c of a.incomeByCategory) rows.push([c.category, c.total, c.count]);
  rows.push([]);

  rows.push(['Tanggal', 'Pemasukan', 'Pengeluaran']);
  for (const d of a.series) rows.push([d.date, d.income, d.expense]);
  return toCsv(rows);
}

// Header untuk respons CSV. Dipisah dari pengiriman supaya bisa dipakai
// Express (res) maupun Worker (Response).
function downloadHeaders(filename) {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  };
}

function download(res, filename, csv) {
  for (const [k, v] of Object.entries(downloadHeaders(filename))) res.setHeader(k, v);
  res.send(csv);
}

module.exports = { transactionsCsv, summaryCsv, toCsv, download, downloadHeaders, formatIDR };
