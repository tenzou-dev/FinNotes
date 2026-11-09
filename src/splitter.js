'use strict';

const { parse } = require('./parser');

const NUM_GLOBAL =
  /(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:ribu|jt|juta|miliar|ml|rb|k|j|m)?/gi;

const WORD_CONNECTORS = /\b(?:sama|terus|lagi|dan|kemudian|plus|namun|berikutnya|selain itu)\b/gi;
const PUNCT_CONNECTORS = /[,;+•]/g;

function spans(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function isSplitPoint(c, amountSpans) {
  const before = amountSpans.some((a) => a.end <= c.start);
  const after = amountSpans.some((a) => a.start >= c.end);
  return before && after;
}

function splitText(text) {
  const amountSpans = spans(NUM_GLOBAL, text);
  if (amountSpans.length < 2) return [text];

  const candidates = [
    ...spans(WORD_CONNECTORS, text),
    ...spans(PUNCT_CONNECTORS, text),
  ].sort((a, b) => a.start - b.start);

  const points = candidates.filter((c) => isSplitPoint(c, amountSpans));
  if (!points.length) return [text];

  const chunks = [];
  let cursor = 0;
  for (const p of points) {
    const head = text.slice(cursor, p.start).trim();
    if (head) chunks.push(head);
    cursor = p.end;
  }
  const tail = text.slice(cursor).trim();
  if (tail) chunks.push(tail);
  return chunks.length ? chunks : [text];
}

function parseMany(text, opts = {}) {
  const chunks = splitText(String(text == null ? '' : text).trim());
  const parts = chunks.map((c) => ({ chunk: c.trim(), parsed: parse(c, opts) }));
  const usable = parts.filter((p) => p.parsed.amount);

  if (usable.length < 2) {
    const single = parse(text, opts);
    return { isMulti: false, items: usable.length ? [usable[0].parsed] : [], single };
  }

  const fallbackType =
    opts.forceType ||
    parse(text, opts).type ||
    usable.find((p) => p.parsed.type)?.parsed.type ||
    null;

  const items = usable.map(({ chunk, parsed: p }) => {
    const item = {
      raw: chunk,
      amount: p.amount,
      type: p.type || fallbackType,
      category: p.category,
      note: p.note,
      date: p.date,
      confidence: p.confidence,
      needsType: !p.type && !fallbackType,
    };
    if (item.type && (!item.category || item.category.startsWith('Lainnya')) && !p.type) {
      const re = parse('x ' + chunk, { forceType: item.type });
      item.category = re.category;
    }
    return item;
  });

  return { isMulti: true, items, single: null };
}

const SPLIT_EXAMPLES = [
  'beli nasi 25rb sama kopi 15rb',
  'gaji 5jt dan bonus 2jt',
  'bayar listrik 300rb, wifi 250rb',
  'bayar angsuran 350rb sama cicilan hp 200rb',
  'jual kue 100rb, roti 50rb, teh 25rb',
];

module.exports = { parseMany, splitText, SPLIT_EXAMPLES };
