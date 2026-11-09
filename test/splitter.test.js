'use strict';

const { parseMany, splitText } = require('../src/splitter');
const { parse } = require('../src/parser');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

console.log('--- split: aman dari angka desimal/ribuan ---');
eq('1,2jt tidak split', splitText('bayar angsuran 1,2jt'), ['bayar angsuran 1,2jt']);
eq('1.000.000 tidak split', splitText('gaji 1.000.000'), ['gaji 1.000.000']);
eq('tanpa connector', splitText('kopi 25rb'), ['kopi 25rb']);
eq('sama', splitText('beli nasi 25rb sama kopi 15rb'), ['beli nasi 25rb', 'kopi 15rb']);
eq('koma', splitText('bayar listrik 300rb, wifi 250rb'), ['bayar listrik 300rb', 'wifi 250rb']);
eq('tiga item', splitText('jual kue 100rb, roti 50rb, teh 25rb'), ['jual kue 100rb', 'roti 50rb', 'teh 25rb']);
eq('connector tanpa nominal sebelum', splitText('kopi sama teh 15rb'), ['kopi sama teh 15rb']);
eq('connector tanpa nominal sesudah', splitText('kopi 25rb sama'), ['kopi 25rb sama']);

console.log('--- parseMany: hasil ---');
const m1 = parseMany('beli nasi 25rb sama kopi 15rb');
ok('multi terdeteksi', m1.isMulti === true);
eq('2 item', m1.items.length, 2);
eq('item 1', [m1.items[0].type, m1.items[0].amount, m1.items[0].category], ['expense', 25000, 'Makan & Minum']);
eq('item 2', [m1.items[1].type, m1.items[1].amount, m1.items[1].category], ['expense', 15000, 'Makan & Minum']);
eq('note item 1', m1.items[0].note, 'Beli nasi');
eq('note item 2', m1.items[1].note, 'Kopi');

const m2 = parseMany('gaji 5jt dan bonus 2jt');
ok('income multi', m2.isMulti && m2.items.every((i) => i.type === 'income'));
eq('kategori beda', [m2.items[0].category, m2.items[1].category], ['Gaji', 'Bonus']);
eq('nominal', [m2.items[0].amount, m2.items[1].amount], [5000000, 2000000]);

const m3 = parseMany('bayar angsuran 350rb sama 250rb');
ok('tipe diwarisi', m3.items[1].type === 'expense', m3.items[1].type);
ok('tidak needsType', m3.items.every((i) => !i.needsType));

const m4 = parseMany('kopi 25rb');
ok('single bukan multi', m4.isMulti === false && m4.items.length === 1);

const m5 = parseMany('50rb sama 30rb');
ok('tanpa keyword -> semua needsType', m5.items.every((i) => !i.type && i.needsType), JSON.stringify(m5.items.map(i=>i.type)));

const m6 = parseMany('+ 50rb sama 30rb');
ok('force + berlaku ke semua', m6.items.every((i) => i.type === 'income'), JSON.stringify(m6.items.map(i=>i.type)));

const m7 = parseMany('listrik 300rb kemarin sama wifi 250rb kemarin');
ok('tanggal semua item', m7.items.length === 2 && m7.items[0].date === m7.items[1].date);
ok('tanggal bukan hari ini', m7.items[0].date !== parse('x').date);

console.log('--- regresi: single masih jalan ---');
eq('gaji single', [parse('gaji 1jt').type, parse('gaji 1jt').amount], ['income', 1000000]);
eq('beli nasi single', [parse('beli nasi 25rb').type, parse('beli nasi 25rb').category], ['expense', 'Makan & Minum']);

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); console.log(''); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
