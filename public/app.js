import { initAuth, getConfig, getSession, clearSession, apiJson, apiFetch } from './api.js';

const $ = (s) => document.querySelector(s);
const el = {
  houseLabel: $('#houseLabel'), whoami: $('#whoami'), joinCode: $('#joinCode'),
  joinRow: $('#joinRow'), members: $('#members'), backendNote: $('#backendNote'), menu: $('#menu'),
  balance: $('#vBalance'), income: $('#vIncome'), expense: $('#vExpense'),
  dBalance: $('#dBalance'), dIncome: $('#dIncome'), dExpense: $('#dExpense'),
  donut: $('#donut'), donutTotal: $('#donutTotal'), legend: $('#legend'),
  chartTitle: $('#chartTitle'), chartSub: $('#chartSub'),
  bars: $('#bars'), barsAxis: $('#barsAxis'),
  txList: $('#txList'), txEmpty: $('#txEmpty'), txCount: $('#txCount'), search: $('#search'),
  chatLog: $('#chatLog'), chatForm: $('#chatForm'), msgInput: $('#msgInput'),
  suggest: $('#suggest'), toast: $('#toast'),
  sheet: $('#sheet'), sheetTitle: $('#sheetTitle'),
  sNote: $('#sNote'), sAmount: $('#sAmount'), sDate: $('#sDate'), sCategory: $('#sCategory'),
};

const state = {
  period: 'month', range: 'month', filter: 'all', query: '',
  tx: [], messages: [], totals: { income: 0, expense: 0, balance: 0 },
  categories: [], user: null, household: null, draft: null, editing: null,
};

const rp = (n) => 'Rp' + Math.round(Math.abs(n || 0)).toLocaleString('id-ID');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.toast.hidden = true), 2400);
}

function humanDate(isoStr) {
  if (!isoStr) return '';
  if (isoStr === iso(new Date())) return 'Hari ini';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (isoStr === iso(y)) return 'Kemarin';
  const d = new Date(isoStr + 'T00:00:00');
  return isNaN(d) ? isoStr : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

const iconFor = (cat) => (state.categories.find((c) => c.name === cat)?.icon) || '💰';

/* ---------------- stats ---------------- */

function renderStats() {
  const t = state.totals;
  const balance = t.balance || 0;
  el.balance.textContent = (balance < 0 ? '-' : '') + rp(balance);
  el.balance.classList.toggle('is-negative', balance < 0);
  el.income.textContent = rp(t.income);
  el.expense.textContent = rp(t.expense);

  el.dBalance.textContent = '';
  el.dIncome.textContent = '';
  el.dExpense.textContent = '';
}

function renderDelta(a) {
  const cur = a.summary, prev = a.comparison;
  const pct = (now, before) => {
    if (before === undefined) return null;
    if (!before) return now ? { txt: 'baru', up: true } : null;
    const d = ((now - before) / before) * 100;
    if (Math.abs(d) < 0.5) return { txt: 'sama kayak periode lalu', up: null };
    return { txt: `${d > 0 ? '+' : ''}${d.toFixed(0)}% vs periode lalu`, up: d > 0 };
  };
  const set = (node, res, goodUp) => {
    node.textContent = res ? res.txt : '';
    node.className = 'stat-delta' + (!res || res.up === null ? '' : res.up === goodUp ? ' good' : ' bad');
  };
  if (a.comparison?.available === false) {
    for (const n of [el.dIncome, el.dExpense, el.dBalance]) { n.textContent = ''; n.className = 'stat-delta'; }
    return;
  }
  set(el.dIncome, pct(cur.income, prev.income), true);
  set(el.dExpense, pct(cur.expense, prev.expense), false);
  set(el.dBalance, pct(cur.net, prev.income - prev.expense), true);
}

/* ---------------- donut chart (SVG, tanpa library) ---------------- */

function renderDonut(rows, total, centerLabel) {
  const R = 15.9155, C = 2 * Math.PI * R;
  el.donut.innerHTML = '';

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('r', R);
  track.setAttribute('cx', '21'); track.setAttribute('cy', '21');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', '#202c33');
  track.setAttribute('stroke-width', '5');
  el.donut.appendChild(track);

  if (!rows.length || !total) {
    el.legend.innerHTML = '<li class="legend-empty">Belum ada data di periode ini</li>';
    el.donutTotal.textContent = rp(0);
    return;
  }

  let offset = 25;
  for (const r of rows) {
    const len = (r.total / total) * C;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', R); c.setAttribute('cx', '21'); c.setAttribute('cy', '21');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', r.color);
    c.setAttribute('stroke-width', '5');
    c.setAttribute('stroke-dasharray', `${len} ${C - len}`);
    c.setAttribute('stroke-dashoffset', offset);
    c.setAttribute('transform', 'rotate(-90 21 21)');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${r.category}: ${rp(r.total)} (${Math.round((r.total / total) * 100)}%)`;
    c.appendChild(title);
    el.donut.appendChild(c);
    offset -= len;
  }

  el.donutTotal.textContent = rp(total);
  el.legend.innerHTML = rows.map((r) => `
    <li>
      <span class="dot" style="background:${r.color}"></span>
      <span class="lg-name">${esc(r.category)}</span>
      <span class="lg-val">${rp(r.total)}</span>
      <span class="lg-pct">${Math.round((r.total / total) * 100)}%</span>
    </li>`).join('');
}

/* ---------------- bar chart ---------------- */

function renderBars(series) {
  el.bars.innerHTML = '';
  el.barsAxis.innerHTML = '';
  if (!series.length) {
    el.bars.innerHTML = '<div class="bars-empty">Belum ada transaksi di periode ini</div>';
    return;
  }
  const max = Math.max(...series.map((d) => Math.max(d.income, d.expense)), 1);
  for (const d of series.slice(-14)) {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.innerHTML = `
      <div class="bar-pair">
        <div class="bar in"  style="height:${(d.income / max) * 100}%"  title="Masuk ${rp(d.income)}"></div>
        <div class="bar out" style="height:${(d.expense / max) * 100}%" title="Keluar ${rp(d.expense)}"></div>
      </div>
      <span class="bar-label">${esc(d.dateHuman)}</span>`;
    el.bars.appendChild(col);
  }
  el.barsAxis.innerHTML = `<span>Masuk</span><span>Keluar</span>`;
}

async function loadAnalytics() {
  try {
    const a = await apiJson(`/api/analytics?period=${state.range}`);
    renderDelta(a);
    renderDonut(a.expenseByCategory, a.summary.expense);
    renderBars(a.series);
    el.chartSub.textContent = `${a.label} · ${a.summary.count} transaksi`;

    if (state.range === 'month') state.totals = a.totals;
    else {
      state.totals = { ...state.totals, income: a.summary.income, expense: a.summary.expense, balance: a.summary.net };
    }
    renderStats();

    if (a.members?.length > 1) {
      el.members.innerHTML = a.members.map((m) => `<span class="member">👤 ${esc(m.name)}</span>`).join('');
    } else {
      el.members.innerHTML = '';
    }
  } catch (e) {
    console.error('analytics', e);
  }
}

/* ---------------- transaksi list ---------------- */

function renderTx() {
  const q = state.query.toLowerCase();
  const list = state.tx.filter((t) => {
    if (state.filter !== 'all' && t.type !== state.filter) return false;
    if (!q) return true;
    return `${t.note} ${t.category} ${rp(t.amount)} ${t.author || ''}`.toLowerCase().includes(q);
  });

  el.txList.innerHTML = list.map((t) => `
    <li class="tx" data-id="${esc(t.id)}">
      <div class="tx-icon">${iconFor(t.category)}</div>
      <div class="tx-body">
        <div class="tx-note">${esc(t.note)}</div>
        <div class="tx-meta">${esc(t.category)} · ${humanDate(t.date)}${t.author ? ' · ' + esc(t.author) : ''}</div>
      </div>
      <div class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${rp(t.amount)}</div>
      <button class="tx-edit" data-act="edit" title="Ubah">✎</button>
      <button class="tx-del" data-act="del" title="Hapus">✕</button>
    </li>`).join('');

  el.txCount.textContent = `${list.length} transaksi`;
  el.txEmpty.hidden = list.length > 0;
}

/* ---------------- chat ---------------- */

function addMsg(role, text, time, extra) {
  const div = document.createElement('div');
  div.className = 'msg ' + role + (role === 'bot' && extra?.isError ? ' err' : '');
  div.textContent = text;
  if (time) {
    const t = document.createElement('time');
    t.textContent = time;
    div.appendChild(t);
  }
  if (extra?.transactions?.length) {
    const box = document.createElement('div');
    box.className = 'txbatch';
    for (const t of extra.transactions) {
      const row = document.createElement('div');
      row.className = 'txbatch-row';
      row.innerHTML = `<span class="tb-sign ${t.type}">${t.type === 'income' ? '+' : '−'}</span>
        <span class="tb-note">${esc(t.note)}</span>
        <span class="tb-cat">${iconFor(t.category)} ${esc(t.category)}</span>
        <span class="tb-amt ${t.type}">${rp(t.amount)}</span>`;
      box.appendChild(row);
    }
    div.appendChild(box);
  }
  if (extra?.pick) attachPick(div, extra);
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
  return div;
}

function attachPick(node, extra) {
  const wrap = document.createElement('div');
  wrap.className = 'pick';
  for (const [label, type, cls] of [['Ya, pemasukan', 'income', 'yes'], ['Tidak, pengeluaran', 'expense', 'no']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = () => { wrap.remove(); sendType(extra.draft, type); };
    wrap.appendChild(b);
  }
  node.appendChild(wrap);
}

function renderMessages() {
  el.chatLog.innerHTML = '';
  if (!state.messages.length) {
    addMsg('bot', 'Halo! Aku Kasir Chat.\n\nTulis transaksi seperti ngobrol, misalnya:\n"gaji 1jt"\n"bayar angsuran 350rb"\n"beli nasi 25rb sama kopi 15rb"\n\nAku yang nebak itu pemasukan atau pengeluaran. Ketik "bantu" untuk contoh lengkap.');
  } else {
    for (const m of state.messages) {
      if (m.role === 'user') addMsg('user', m.text, clockOf(m.createdAt));
      else {
        if (m.payload?.needsType) state.draft = m.payload.draft;
        addMsg('bot', m.text, clockOf(m.createdAt), m.payload);
      }
    }
  }
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

const now = () => new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
function clockOf(v) {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  return isNaN(d) ? '' : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function renderSuggest() {
  const list = ['gaji 1jt', 'bayar angsuran 350rb', 'beli nasi 25rb sama kopi 15rb', 'kopi 25k', 'rekap bulan ini', 'bantu'];
  el.suggest.innerHTML = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s;
    b.onclick = () => { el.msgInput.value = s; send(); };
    el.suggest.appendChild(b);
  }
}

async function refresh(keepScroll = false) {
  const log = el.chatLog;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const data = await apiJson('/api/state');
  state.tx = data.transactions;
  state.messages = data.messages;
  state.totals = data.totals;
  state.categories = data.categories;
  renderStats();
  renderTx();
  renderMessages();
  await loadAnalytics();
  if (keepScroll || atBottom) log.scrollTop = log.scrollHeight;
}

async function postChat(payload) {
  const r = await apiJson('/api/chat', { method: 'POST', body: JSON.stringify(payload) });
  return r;
}

async function send() {
  const text = el.msgInput.value.trim();
  if (!text) return;
  el.msgInput.value = '';
  addMsg('user', text, now());
  const thinking = addMsg('bot', '…', '');
  try {
    const r = await postChat({ text });
    thinking.remove();
    addMsg('bot', r.text, now(), r);
    state.draft = r.needsType ? r.draft : null;
    await refresh(true);
  } catch (e) {
    thinking.remove();
    addMsg('bot', 'Maaf, error: ' + e.message, '', { isError: true });
  }
}

async function sendType(draft, type) {
  addMsg('user', type === 'income' ? 'Ya, pemasukan' : 'Tidak, pengeluaran', now());
  const thinking = addMsg('bot', '…', '');
  try {
    const r = await postChat({ draft, type });
    thinking.remove();
    addMsg('bot', r.text, now(), r);
    state.draft = null;
    await refresh(true);
  } catch (e) {
    thinking.remove();
    addMsg('bot', 'Maaf, error: ' + e.message, '', { isError: true });
  }
}

/* ---------------- edit sheet ---------------- */

function openSheet(tx) {
  state.editing = tx;
  el.sheetTitle.textContent = 'Ubah Transaksi';
  el.sNote.value = tx.note;
  el.sAmount.value = tx.amount;
  el.sDate.value = tx.date;
  el.sCategory.innerHTML = state.categories
    .map((c) => `<option value="${esc(c.name)}" ${c.name === tx.category ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`)
    .join('');
  document.querySelectorAll('#sheetType .chip').forEach((b) => b.classList.toggle('is-active', b.dataset.type === tx.type));
  el.sheet.hidden = false;
}

function closeSheet() { el.sheet.hidden = true; state.editing = null; }

async function saveSheet() {
  const tx = state.editing;
  if (!tx) return;
  const type = document.querySelector('#sheetType .chip.is-active')?.dataset.type || tx.type;
  const amount = Number(String(el.sAmount.value).replace(/[^\d]/g, ''));
  if (!amount || amount < 1) return toast('Nominal tidak valid');
  try {
    await apiJson(`/api/transactions/${tx.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ type, note: el.sNote.value.trim(), amount, date: el.sDate.value, category: el.sCategory.value }),
    });
    closeSheet();
    toast('Transaksi diperbarui');
    await refresh();
  } catch (e) { toast('Gagal: ' + e.message); }
}

/* ---------------- boot ---------------- */

async function boot() {
  try {
    const { config } = await initAuth();

    if (config.backend === 'supabase' && !getSession()) {
      location.href = './login.html';
      return;
    }
    if (config.backend !== 'supabase' && getSession()?.access_token === 'local') {
      localStorage.removeItem('kj_session');
    }

    const me = await apiJson('/api/auth/me');
    state.user = me.user;
    el.whoami.textContent = me.user.name || me.user.email;
    el.houseLabel.textContent = me.households?.[0]?.name || 'Buku';
    el.backendNote.textContent = config.backend === 'supabase'
      ? 'Tersimpan di Supabase' : 'Tersimpan lokal (SQLite)';

    const warned = sessionStorage.getItem('kj_signup_warning');
    if (warned) {
      sessionStorage.removeItem('kj_signup_warning');
      toast(`Kode undangan ditolak (${warned}). Household "${el.houseLabel.textContent}" dibuat untukmu.`);
    }

    await refresh();
  } catch (e) {
    if (/login|401/i.test(e.message)) {
      clearSession();
      location.href = './login.html';
    } else {
      document.body.innerHTML = `<div style="padding:40px;text-align:center"><h2>Gagal memuat</h2><p style="color:#8696a0">${esc(e.message)}</p></div>`;
    }
  }
}

el.chatForm.addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('#btnHelp').onclick = () => { el.msgInput.value = 'bantu'; send(); };

el.search.addEventListener('input', (e) => { state.query = e.target.value; renderTx(); });

$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  state.filter = c.dataset.filter;
  document.querySelectorAll('#chips .chip').forEach((x) => x.classList.toggle('is-active', x === c));
  renderTx();
});

$('#periodTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  state.period = b.dataset.period;
  state.range = b.dataset.period;
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
  document.querySelectorAll('.itab').forEach((x) => x.classList.toggle('is-active', x.dataset.range === b.dataset.period));
  loadAnalytics();
});

$('#insightTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.itab');
  if (!b) return;
  state.range = b.dataset.range;
  document.querySelectorAll('.itab').forEach((x) => x.classList.toggle('is-active', x === b));
  const seg = document.querySelector(`.seg-btn[data-period="${b.dataset.range}"]`);
  if (seg) {
    state.period = b.dataset.range;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === seg));
  }
  loadAnalytics();
});

el.txList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.tx').dataset.id;
  if (btn.dataset.act === 'edit') {
    openSheet(state.tx.find((t) => t.id === id));
  } else {
    if (!confirm('Hapus transaksi ini?')) return;
    try {
      await apiJson('/api/transactions/' + id, { method: 'DELETE' });
      toast('Transaksi dihapus');
      await refresh();
    } catch (err2) { toast('Gagal: ' + err2.message); }
  }
});

$('#btnMenu').onclick = () => { el.menu.hidden = !el.menu.hidden; };
document.addEventListener('click', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && e.target !== $('#btnMenu')) el.menu.hidden = true;
});

$('#btnLogout').onclick = async () => {
  clearSession();
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { }
  location.href = './login.html';
};

$('#btnReset').onclick = async () => {
  if (!confirm('Hapus SEMUA transaksi? Saldo kembali Rp0. Tidak bisa dibatalkan.')) return;
  try {
    await postChat({ text: 'hapus semua' });
    toast('Semua transaksi dihapus');
    await refresh(true);
  } catch (e) { toast('Gagal: ' + e.message); }
};

$('#sheetClose').onclick = closeSheet;
$('#sheetSave').onclick = saveSheet;
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });
$('#sheetType').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  document.querySelectorAll('#sheetType .chip').forEach((x) => x.classList.toggle('is-active', x === c));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.sheet.hidden) closeSheet(); });

renderSuggest();
boot();
