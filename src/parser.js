'use strict';

const INCOME = 'income';
const EXPENSE = 'expense';

const RULES = [
  { type: INCOME, category: 'Gaji', weight: 10, kw: ['gaji', 'salary', 'pokok gaji', 'gaji bulanan'] },
  { type: INCOME, category: 'Bonus', weight: 9, kw: ['bonus', 'thr', 'insentif'] },
  { type: INCOME, category: 'Pendapatan', weight: 9, kw: ['pemasukan', 'pendapatan', 'income'] },
  { type: INCOME, category: 'Refund', weight: 9, kw: ['refund', 'cashback', 'kembalian', 'pengembalian', 'reimburse'] },
  { type: INCOME, category: 'Transfer Masuk', weight: 6, kw: ['dibayar', 'dibayarkan', 'diterima', 'masuk ke', 'diantar'] },
  { type: INCOME, category: 'Komisi', weight: 7, kw: ['komisi', 'lembur', 'fee', 'honor'] },
  { type: INCOME, category: 'Investasi', weight: 7, kw: ['dividen', 'bunga', 'saham', 'profit', 'untung', 'hasil investasi'] },
  { type: INCOME, category: 'Bantuan', weight: 7, kw: ['bantuan', 'infaq', 'beasiswa'] },
  { type: INCOME, category: 'Jualan', weight: 8, kw: ['jualan', 'jual', 'laku', 'omzet', 'warung', 'bisnis', 'usaha', 'terjual', 'rakitan'] },
  { type: INCOME, category: 'Transfer Masuk', weight: 5, kw: ['transfer', 'masuk', 'terima', 'setoran', 'dana'] },

  { type: EXPENSE, category: 'Cicilan', weight: 9, kw: ['angsuran', 'cicilan', 'kpr', 'kredit', 'pinjaman', 'tenor'] },
  { type: EXPENSE, category: 'Tagihan', weight: 9, kw: ['listrik', 'pln', 'air', 'pdam', 'wifi', 'internet', 'indihome', 'pulsa', 'token', 'bpjs', 'kabel'] },
  { type: EXPENSE, category: 'Transportasi', weight: 8, kw: ['bensin', 'bbm', 'solar', 'mobil', 'motor', 'parkir', 'tol', 'grab', 'gojek', 'uber', 'taxi', 'transport', 'ojek'] },
  { type: EXPENSE, category: 'Kesehatan', weight: 8, kw: ['obat', 'dokter', 'rumah sakit', 'klinik', 'checkup', 'vitamin', 'apotek', 'gigi'] },
  { type: EXPENSE, category: 'Pendidikan', weight: 8, kw: ['sekolah', 'spp', 'kursus', 'buku', 'kuliah', 'les', 'bimbel'] },
  { type: EXPENSE, category: 'Sosial', weight: 9, kw: ['zakat', 'sedekah', 'donasi', 'infak', 'wakaf', 'arisan', 'iuran', 'kondangan', 'baju'] },
  { type: EXPENSE, category: 'Makan & Minum', weight: 7, kw: ['makan', 'minum', 'kopi', 'nasi', 'lunch', 'dinner', 'breakfast', 'sarapan', 'jajan', 'snack', 'roti', 'cafe', 'boba', 'teh', 'resto'] },
  { type: EXPENSE, category: 'Belanja', weight: 7, kw: ['beli', 'belanja', 'shopping', 'tokopedia', 'tokped', 'shopee', 'lazada', 'blibli', 'amazon', 'bukalapak', 'sepatu'] },
  { type: EXPENSE, category: 'Hiburan', weight: 7, kw: ['nonton', 'film', 'hiburan', 'game', 'netflix', 'spotify', 'disney', 'potong', 'barber', 'pangkas', 'laundry', 'bioskop'] },
  { type: EXPENSE, category: 'Bayar', weight: 5, kw: ['bayar', 'bayaran', 'tarik', 'kirim', 'topup', 'biaya', 'ongkir', 'ongkos', 'admin', 'sewa', 'kontrakan', 'kos'] },
  { type: EXPENSE, category: 'Tabungan', weight: 7, kw: ['nabung', 'tabung', 'deposito', 'dana darurat'] },
  { type: EXPENSE, category: 'Lainnya', weight: 6, kw: ['keluar', 'kurangin', 'kurang', 'pengeluaran'] },
];

const UNIT = {
  rb: 1e3, ribu: 1e3, k: 1e3,
  jt: 1e6, juta: 1e6, j: 1e6, m: 1e6,
  miliar: 1e9, ml: 1e9,
};

const NUM_RE = /(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:ribu|jt|juta|miliar|ml|rb|k|j|m)?/gi;
const RP_RE = /(?:^|\s)(?:rp\.?|idr|rupiah)\s*/gi;

const CANCEL_RE = /\b(gak|nggak|ndak|nanti|jangan|belum|batal)\b/i;
const PLUS_RE = /^\s*\+|(?:^|\s)(tambah|tambahin|nambah|nambahin)\b/i;
const MINUS_RE = /^\s*-|(?:^|\s)(kurangin|kurang)\b/i;
const INCOME_VERBS = /(?:terima|masuk|dapat|income|masukin|diterima)/i;

// "transfer ke bank" (expense) vs "transfer dari bank" (income) - context beats bare keyword
const CONTEXT_RULES = [
  { re: /\b(?:transfer|kirim|bayar|setor|tarik|top\s*up|topup|nb|ng)\b[^\w]*(?:ke|kpd|kepada|di)\b/i, type: EXPENSE },
  { re: /\b(?:transfer|masuk|terima|setor|top\s*up|topup)\b[^\w]*dari\b/i, type: INCOME },
  { re: /\btarik\s*(?:tunai|cash|uang)\b/i, type: EXPENSE },
  { re: /\b(?:dari|ke)\s+(?:rekening|rek|tabungan|bank)\b/i, type: null },
];

// spec returned by fn(): { days, months, y, mo (0-based), d }
const DATE_RES = [
  { re: /\b(?:hari\s*ini|tadi\s*pagi|tadi\s*malam)\b/, fn: () => ({ days: 0 }) },
  { re: /\bkemarin\s*lusa\b/, fn: () => ({ days: -2 }) },
  { re: /\bkemarin\b/, fn: () => ({ days: -1 }) },
  { re: /\b(\d{1,2})\s*bulan\s*lalu\b/, fn: (m) => ({ months: -Math.abs(+m[1]) }) },
  { re: /\b(\d{1,2})\s*(?:hari|minggu)\s*lalu\b/, fn: (m) => ({ days: -Math.abs(+m[1]) * (/minggu/.test(m[0]) ? 7 : 1) }) },
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, fn: (m) => ({ y: +m[1], mo: +m[2] - 1, d: +m[3] }) },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, fn: (m) => ({ y: fixYear(m[3]), mo: +m[2] - 1, d: +m[1] }) },
  { re: /\b(\d{1,2})\/(\d{1,2})\b/, fn: (m) => ({ d: +m[1], mo: +m[2] - 1 }) },
  {
    re: /\b(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|ags|sep|oct|nov|des)\b(?:\s+(\d{4}))?/i,
    fn: (m) => ({ d: +m[1], mo: MONTH_IDX[m[2].toLowerCase()], y: m[3] ? +m[3] : undefined }),
  },
];

const MONTH_IDX = {
  januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6,
  agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, ags: 7, sep: 8, oct: 9, nov: 10, des: 11,
};

function fixYear(y) {
  let n = +y;
  if (n < 100) n += 2000;
  return n;
}

function toInt(n) {
  return Math.round(n);
}

function formatIDR(n) {
  return 'Rp' + toInt(Math.abs(n)).toLocaleString('id-ID');
}

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\r/g, '')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordRegex(kw) {
  const body = kw
    .split(/\s+/)
    .map((w) => escapeRe(w) + (/\p{L}$/u.test(w) ? '[a-z]*' : ''))
    .join('[\\s-]+');
  return new RegExp('\\b' + body + '\\b', 'i');
}

const COMPILED_RULES = RULES.map((r) => ({ ...r, regexes: r.kw.map(keywordRegex) }));

function matchRules(text, type) {
  const hits = [];
  for (const rule of COMPILED_RULES) {
    if (type && rule.type !== type) continue;
    for (const re of rule.regexes) {
      const m = re.exec(text);
      if (m) {
        hits.push({ weight: rule.weight, category: rule.category, type: rule.type, word: m[0] });
        break;
      }
    }
  }
  return hits;
}

function detectType(text, forced) {
  if (forced === INCOME || forced === EXPENSE) return { type: forced, confidence: 'forced' };
  for (const ctx of CONTEXT_RULES) {
    if (ctx.type && ctx.re.test(text)) return { type: ctx.type, confidence: 'context' };
  }
  const hits = matchRules(text);
  if (!hits.length) {
    if (MINUS_RE.test(text)) return { type: EXPENSE, confidence: 'symbol' };
    if (PLUS_RE.test(text)) return { type: INCOME, confidence: 'symbol' };
    if (INCOME_VERBS.test(text)) return { type: INCOME, confidence: 'verb' };
    return { type: null, confidence: 'none' };
  }
  hits.sort((a, b) => b.weight - a.weight);
  const best = hits[0];
  const rival = hits[1];
  if (rival && rival.weight === best.weight && rival.type !== best.type) {
    return { type: null, confidence: 'ambiguous', tie: true, best, rival };
  }
  return { type: best.type, confidence: 'keyword', match: best };
}

function detectCategory(text, type) {
  const hits = matchRules(text, type).sort((a, b) => b.weight - a.weight);
  if (hits.length && hits[0].weight >= 5) return hits[0].category;
  return type === INCOME ? 'Lainnya (Masuk)' : 'Lainnya';
}

function parseNumberToken(token) {
  const s = token.toLowerCase().replace(/\s+/g, '');
  const um = s.match(/^(.+?)(ribu|juta|miliar|jt|ml|rb|k|j|m)?$/);
  if (!um) return null;
  const numPart = um[1];
  const unit = um[2] || '';
  let base;
  if (numPart.includes(',')) {
    base = parseFloat(numPart.replace(/\./g, '').replace(',', '.'));
  } else if (numPart.includes('.')) {
    const tail = numPart.split('.').pop();
    base = tail.length === 3 ? parseFloat(numPart.replace(/\./g, '')) : parseFloat(numPart);
  } else {
    base = parseInt(numPart, 10);
  }
  if (!isFinite(base)) return null;
  const mult = UNIT[unit] || 1;
  return toInt(base * mult);
}

function extractAmount(text) {
  const clean = text.replace(RP_RE, ' ');
  const matches = clean.match(NUM_RE) || [];
  const vals = matches.map(parseNumberToken).filter((v) => v !== null && v > 0);
  if (!vals.length) return null;
  return Math.max(...vals);
}

function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function extractDate(text, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const { re, fn } of DATE_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const spec = fn(m) || {};
    const d = new Date(today);
    if (spec.y != null) d.setFullYear(spec.y);
    if (spec.mo != null) d.setMonth(spec.mo);
    if (spec.d != null) d.setDate(spec.d);
    if (spec.days) d.setDate(d.getDate() + spec.days);
    if (spec.months) d.setMonth(d.getMonth() + spec.months);
    return iso(d);
  }
  return iso(today);
}

function extractNote(text, type) {
  let t = text.replace(RP_RE, ' ');
  t = t.replace(NUM_RE, ' ');
  for (const { re } of DATE_RES) t = t.replace(re, ' ');
  t = t.replace(CANCEL_RE, ' ');
  t = t.replace(/(?:^|\s)(tambah|tambahin|kurang|kurangin|nambah|nambahin)\b/gi, ' ');
  t = t.replace(/^[\s,.:;+-]+/, '').replace(/[\s,.:;+-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!t) return type === INCOME ? 'Pemasukan' : 'Pengeluaran';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parse(text, opts = {}) {
  const raw = normalize(text);
  const amount = opts.amount != null ? opts.amount : extractAmount(raw);
  const date = opts.date || extractDate(raw);
  const det = detectType(raw, opts.forceType || null);
  const type = det.type;
  return {
    ok: !!amount && !!type,
    amount,
    type,
    category: type ? (opts.category || detectCategory(raw, type)) : null,
    note: extractNote(raw, type || EXPENSE),
    date,
    raw,
    confidence: det.confidence,
    match: det.match || null,
    tie: !!det.tie,
    needsType: !!amount && !type,
  };
}

const EXAMPLES = [
  'gaji 1jt',
  'bayar angsuran 350rb',
  'kopi 25k',
  'bensin 100rb',
  'bonus 2,5jt',
  'jualan kue 450rb',
  'listrik 320rb kemarin',
  'nabung 500rb',
];

module.exports = {
  INCOME,
  EXPENSE,
  RULES,
  EXAMPLES,
  parse,
  extractAmount,
  detectType,
  detectCategory,
  extractDate,
  extractNote,
  parseNumberToken,
  formatIDR,
  normalize,
};
