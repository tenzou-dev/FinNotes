'use strict';

const { INCOME, EXPENSE, EXAMPLES, parse } = require('../src/parser');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function tx(text, opts) {
  const r = parse(text, opts);
  return { amount: r.amount, type: r.type, category: r.category, date: r.date };
}

console.log('--- amount ---');
check('1jt', parse('gaji 1jt').amount, 1000000);
check('350rb', parse('bayar angsuran 350rb').amount, 350000);
check('25k', parse('kopi 25k').amount, 25000);
check('1.000.000', parse('gaji 1.000.000').amount, 1000000);
check('2,5jt', parse('bonus 2,5jt').amount, 2500000);
check('1.5jt', parse('bonus 1.5jt').amount, 1500000);
check('rp 50.000', parse('bayar rp 50.000').amount, 50000);
check('1 juta', parse('gaji 1 juta').amount, 1000000);
check('100 ribu', parse('bayar 100 ribu').amount, 100000);
check('2 miliar', parse('bonheur 2 miliar').amount, 2000000000);
check('10k', parse('makan 10k').amount, 10000);
check('no number', parse('gaji bulan ini').amount, null);

console.log('--- direction ---');
check('gaji -> income', parse('gaji 1jt').type, 'income');
check('bayar -> expense', parse('bayar angsuran 350rb').type, 'expense');
check('masuk -> income', parse('masuk 500rb').type, 'income');
check('kopi -> expense', parse('kopi 25k').type, 'expense');
check('+ -> income', parse('+ 50rb').type, 'income');
check('- -> expense', parse('- 50rb').type, 'expense');
check('ambiguous needs type', parse('50rb').needsType, true);
check('ambiguous type null', parse('50rb').type, null);
check('dibayar -> income', parse('dibayar 750rb').type, 'income');
check('transfer -> expense', parse('transfer ke bank 2jt').type, 'expense');

console.log('--- category ---');
check('gaji category', parse('gaji 5jt').category, 'Gaji');
check('angsuran category', parse('bayar angsuran 350rb').category, 'Cicilan');
check('bensin category', parse('bensin 100rb').category, 'Transportasi');
check('kopi category', parse('kopi 25k').category, 'Makan & Minum');
check('listrik category', parse('listrik 320rb').category, 'Tagihan');
check('nabung category', parse('nabung 500rb').category, 'Tabungan');
check('jualan category', parse('jualan kue 450rb').category, 'Jualan');
check('default income', parse('+ 50rb').category, 'Lainnya (Masuk)');
check('default expense', parse('- 50rb').category, 'Lainnya');

console.log('--- date ---');
const today = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const isoToday = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
const yest = new Date(today);
yest.setDate(yest.getDate() - 1);
const isoYest = `${yest.getFullYear()}-${p2(yest.getMonth() + 1)}-${p2(yest.getDate())}`;
check('hari ini', parse('gaji 1jt hari ini').date, isoToday);
check('kemarin', parse('kopi 30rb kemarin').date, isoYest);
const d2 = new Date(today);
d2.setDate(d2.getDate() - 2);
const isoD2 = `${d2.getFullYear()}-${p2(d2.getMonth() + 1)}-${p2(d2.getDate())}`;
check('2 hari lalu', parse('kopi 30rb 2 hari lalu').date, isoD2);
check('default today', parse('kopi 30rb').date, isoToday);
check('explicit iso', parse('gaji 1jt 2024-03-05').date, '2024-03-05');

console.log('--- note ---');
check('note bayar angsuran', parse('bayar angsuran 350rb').note, 'Bayar angsuran');
check('note gaji', parse('gaji 1jt').note, 'Gaji');
check('note with rp', parse('bayar rp 50.000 bensin').note, 'Bayar bensin');
check('note empty fallback', parse('+ 50rb').note, 'Pemasukan');
check('note with date', parse('kopi 30rb kemarin').note, 'Kopi');
check('note empty fallback', parse('+ 50rb').note, 'Pemasukan');

console.log('--- full shape ---');
check('tx full', tx('gaji 1jt'), { amount: 1000000, type: 'income', category: 'Gaji', date: isoToday });
check('tx expense', tx('bayar angsuran 350rb'), { amount: 350000, type: 'expense', category: 'Cicilan', date: isoToday });

console.log('--- forceType ---');
check('force income', parse('50rb', { forceType: INCOME }).type, 'income');
check('force expense', parse('50rb', { forceType: EXPENSE }).type, 'expense');
check('force keeps amount', parse('50rb', { forceType: INCOME }).amount, 50000);

console.log('--- examples all parse ---');
for (const ex of EXAMPLES) {
  const r = parse(ex);
  if (!r.ok) failures.push(`example failed to parse: ${ex} -> ${JSON.stringify(r)}`);
  else pass++;
}

console.log('');
if (fail) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
