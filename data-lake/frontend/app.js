/* Colorado Business Data Lake — dashboard + live query runner.
   Charts are hand-rolled SVG (strict same-origin CSP, no libraries): one
   validated hue for single-series marks, terracotta for emphasis, thin marks,
   hairline grids, tooltips on every mark. */

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(Math.round(n));
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
const fmtCost = (c) => (c < 0.001 ? '<$0.001' : '$' + c.toFixed(3));

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, style = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const [k, v] of Object.entries(style)) n.style[k] = v;
  return n;
}

/* ---- tooltip ---- */
const tip = $('tooltip');
function tipShow(html, evt) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
const tipHide = () => (tip.hidden = true);

function hover(node, html) {
  node.addEventListener('mousemove', (e) => tipShow(html(), e));
  node.addEventListener('mouseleave', tipHide);
}

/* Clean ticks: 0..max in 4 steps rounded to a nice unit. */
function ticks(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return [0, 1, 2, 3, 4].map((i) => i * step);
}

/* Bar with a 4px rounded data-end, square at the baseline (vertical). */
function colPath(x, yTop, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${yTop + h} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yTop + h} Z`;
}
/* Same, horizontal (rounded right end). */
function barPath(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}

const MAIN = 'var(--chart-main)';
const ACCENT = 'var(--chart-accent)';

/* ---- column chart (formations by year) ---- */
function columnChart(mount, data, tipLabel) {
  const W = 940, H = 260, M = { t: 24, r: 12, b: 26, l: 46 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const innerW = W - M.l - M.r, innerH = H - M.t - M.b;
  const tk = ticks(Math.max(...data.map((d) => d.y)));
  const yMax = tk[4];
  const yPos = (v) => M.t + innerH * (1 - v / yMax);

  for (const t of tk.slice(1)) {
    svg.append(el('line', { x1: M.l, x2: W - M.r, y1: yPos(t), y2: yPos(t), class: 'gridline' }));
    svg.append(Object.assign(el('text', { x: M.l - 6, y: yPos(t) + 4, 'text-anchor': 'end' }), { textContent: fmtK(t) }));
  }
  svg.append(el('line', { x1: M.l, x2: W - M.r, y1: yPos(0), y2: yPos(0), class: 'baseline' }));

  const step = innerW / data.length;
  const bw = Math.min(24, step - 2);
  const maxD = data.reduce((a, b) => (b.y > a.y ? b : a));
  data.forEach((d, i) => {
    const x = M.l + i * step + (step - bw) / 2;
    const h = Math.max(1, innerH * (d.y / yMax));
    const isPeak = d === maxD;
    const p = el('path', { d: colPath(x, yPos(0) - h, bw, h) }, { fill: isPeak ? ACCENT : MAIN });
    hover(p, () => `${fmt(d.y)}<small>${tipLabel} · ${d.x}</small>`);
    svg.append(p);
    if (d.x % 5 === 0) {
      svg.append(Object.assign(el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }), { textContent: d.x }));
    }
    if (isPeak) {
      svg.append(Object.assign(el('text', { x: x + bw / 2, y: yPos(0) - h - 7, 'text-anchor': 'middle', class: 'val' }), { textContent: fmtK(d.y) }));
    }
  });
  mount.replaceChildren(svg);
  return maxD;
}

/* ---- horizontal top-N bars (label above bar, value at the tip) ---- */
function hbarChart(mount, data, tipLabel) {
  const W = 460, rowH = 40, M = { t: 4, l: 2, r: 64 };
  const H = M.t + data.length * rowH;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const max = Math.max(...data.map((d) => d.value));
  data.forEach((d, i) => {
    const y = M.t + i * rowH;
    const w = Math.max(2, (W - M.l - M.r) * (d.value / max));
    svg.append(Object.assign(el('text', { x: M.l, y: y + 12 }), { textContent: d.label }));
    const p = el('path', { d: barPath(M.l, y + 18, w, 14) }, { fill: MAIN });
    hover(p, () => `${fmt(d.value)}<small>${tipLabel} · ${d.label}</small>`);
    svg.append(p);
    svg.append(Object.assign(el('text', { x: M.l + w + 6, y: y + 29, class: 'val' }), { textContent: fmtK(d.value) }));
  });
  mount.replaceChildren(svg);
}

/* ---- line chart (cohort survival %) ---- */
function lineChart(mount, data) {
  const W = 460, H = 240, M = { t: 18, r: 46, b: 24, l: 36 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const innerW = W - M.l - M.r, innerH = H - M.t - M.b;
  const yMax = 100;
  const x0 = data[0].x, x1 = data[data.length - 1].x;
  const xPos = (x) => M.l + innerW * ((x - x0) / (x1 - x0));
  const yPos = (v) => M.t + innerH * (1 - v / yMax);

  for (const t of [25, 50, 75, 100]) {
    svg.append(el('line', { x1: M.l, x2: W - M.r, y1: yPos(t), y2: yPos(t), class: 'gridline' }));
    svg.append(Object.assign(el('text', { x: M.l - 5, y: yPos(t) + 4, 'text-anchor': 'end' }), { textContent: t + '%' }));
  }
  svg.append(el('line', { x1: M.l, x2: W - M.r, y1: yPos(0), y2: yPos(0), class: 'baseline' }));
  for (const yr of [2000, 2010, 2020]) {
    if (yr >= x0 && yr <= x1)
      svg.append(Object.assign(el('text', { x: xPos(yr), y: H - 6, 'text-anchor': 'middle' }), { textContent: yr }));
  }

  const pts = data.map((d) => `${xPos(d.x).toFixed(1)},${yPos(d.y).toFixed(1)}`);
  svg.append(el('path', { d: 'M' + pts.join(' L') + ` L${xPos(x1)},${yPos(0)} L${xPos(x0)},${yPos(0)} Z` }, { fill: MAIN, opacity: 0.1 }));
  svg.append(el('path', { d: 'M' + pts.join(' L'), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, { fill: 'none', stroke: MAIN, strokeWidth: 2 }));

  const last = data[data.length - 1];
  svg.append(el('circle', { cx: xPos(last.x), cy: yPos(last.y), r: 4 }, { fill: MAIN, stroke: 'var(--surface)', strokeWidth: 2 }));
  svg.append(Object.assign(el('text', { x: xPos(last.x) + 8, y: yPos(last.y) + 4, class: 'val' }), { textContent: last.y.toFixed(0) + '%' }));

  // invisible hit bands for the crosshair tooltip
  const band = innerW / (data.length - 1);
  data.forEach((d) => {
    const hit = el('rect', { x: xPos(d.x) - band / 2, y: M.t, width: band, height: innerH }, { fill: 'transparent' });
    hover(hit, () => `${d.y.toFixed(1)}% still in Good Standing<small>of ${fmt(d.formed)} formed in ${d.x}</small>`);
    svg.append(hit);
  });
  mount.replaceChildren(svg);
}

/* ---- data plumbing ---- */
const TYPE_LABELS = {
  DLLC: 'Domestic LLC', DPC: 'Domestic profit corp', DNC: 'Domestic nonprofit',
  FLLC: 'Foreign LLC', FPC: 'Foreign profit corp', FNC: 'Foreign nonprofit',
  DLP: 'Domestic LP', DLLP: 'Domestic LLP', DLLLP: 'Domestic LLLP', FLP: 'Foreign LP',
  GP: 'General partnership', FO: 'Foreign other',
};
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function loadSummary() {
  const res = await fetch('/api/summary');
  if (!res.ok) throw new Error((await res.json()).message ?? 'summary failed');
  const s = await res.json();
  const m = s.manifest;

  $('stat-rows').textContent = (m.totalRows / 1e6).toFixed(2) + 'M';
  $('stat-scan').textContent = fmtBytes(m.aggregates.status_breakdown.bytesScanned);
  $('stat-partitions').textContent = m.curated.partitions;
  $('stat-snapshot').textContent = m.builtAt.slice(0, 10);

  $('p-source').textContent = `${(m.totalRows / 1e6).toFixed(2)}M rows`;
  $('p-raw').textContent = `${fmtBytes(m.raw.bytes)} · ${m.raw.objects} objects`;
  $('p-ctas').textContent = `rebuilt in ${fmtMs(m.ctas.ms)}`;
  $('p-curated').textContent = `${fmtBytes(m.curated.bytes)} · ${m.curated.partitions} partitions`;
  $('dash-note').textContent =
    `Rendered from aggregates the ETL precomputed into the analytics zone. A count(*) over the Parquet scans ${m.countScannedBytes === 0 ? 'zero bytes' : fmtBytes(m.countScannedBytes)} (the row-group metadata already knows).`;

  const years = s.formations_by_year.rows.map((r) => ({ x: +r[0], y: +r[1] }));
  const peak = columnChart($('chart-years'), years, 'new registrations');
  $('peak-note').textContent = `· peak: ${fmt(peak.y)} in ${peak.x}`;

  hbarChart($('chart-types'), s.entity_types.rows.map((r) => ({ label: TYPE_LABELS[r[0]] ?? r[0], value: +r[1] })), 'entities');
  hbarChart($('chart-status'), s.status_breakdown.rows.map((r) => ({ label: r[0], value: +r[1] })), 'entities');
  hbarChart($('chart-cities'), s.top_cities.rows.slice(0, 8).map((r) => ({ label: titleCase(r[0]), value: +r[1] })), 'in Good Standing');
  lineChart($('chart-survival'), s.cohort_survival.rows.map((r) => ({ x: +r[0], formed: +r[1], y: (100 * +r[2]) / +r[1] })));

  updateUsage(s.usage);
}

function updateUsage(u) {
  if (u) $('usage-note').textContent = `${u.used} of ${u.limit} used today`;
}

/* ---- live query runner ---- */
let queries = [];
let selected = null;

async function loadCatalog() {
  const res = await fetch('/api/queries');
  queries = (await res.json()).queries;
  const pick = $('qpick');
  pick.replaceChildren(
    ...queries.filter((q) => !q.id.startsWith('zone-')).map((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.textContent = q.title;
      b.addEventListener('click', () => select(q, b));
      return b;
    })
  );
  select(queries[0], pick.firstChild);
}

function select(q, btn) {
  selected = q;
  for (const b of $('qpick').children) b.setAttribute('aria-selected', b === btn);
  $('qstory').textContent = q.story;
  $('qsql').textContent = q.sql;
  $('qstats').hidden = true;
  $('q-error').hidden = true;
  $('q-results').hidden = true;
}

async function runQuery(id) {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? 'query failed');
  updateUsage(body.usage);
  return body;
}

function renderStats(r) {
  $('s-scanned').textContent = 'scanned ' + fmtBytes(r.stats.bytesScanned);
  $('s-time').textContent = 'engine ' + fmtMs(r.stats.engineMs);
  $('s-cost').textContent = fmtCost(r.stats.estCostUsd);
  const c = $('s-cache');
  c.textContent = r.cached ? 'cache hit: Athena not re-run' : 'live Athena execution';
  c.classList.toggle('hit', r.cached);
  $('qstats').hidden = false;
}

function renderTable(r) {
  const numeric = r.columns.map((_, i) => r.rows.every((row) => /^-?[\d.]+$/.test(row[i] ?? '')));
  const tbl = $('q-results');
  tbl.replaceChildren();
  const thead = tbl.createTHead().insertRow();
  r.columns.forEach((c, i) => {
    const th = document.createElement('th');
    th.textContent = c;
    if (numeric[i]) th.className = 'num';
    thead.append(th);
  });
  const tb = tbl.createTBody();
  for (const row of r.rows) {
    const tr = tb.insertRow();
    row.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = numeric[i] && v !== '' ? nf.format(+v) : v;
      if (numeric[i]) td.className = 'num';
    });
  }
  tbl.hidden = false;
}

$('run-btn').addEventListener('click', async () => {
  const btn = $('run-btn');
  btn.disabled = true;
  btn.textContent = 'Running in Athena…';
  $('q-error').hidden = true;
  try {
    const r = await runQuery(selected.id);
    renderStats(r);
    renderTable(r);
  } catch (err) {
    $('q-error').textContent = err.message;
    $('q-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run in Athena';
  }
});

/* ---- the race ---- */
$('race-btn').addEventListener('click', async () => {
  const btn = $('race-btn');
  btn.disabled = true;
  btn.textContent = 'Racing…';
  $('race-error').hidden = true;
  try {
    const cur = await runQuery('zone-curated');
    const raw = await runQuery('zone-raw');
    const maxB = Math.max(raw.stats.bytesScanned, cur.stats.bytesScanned);
    $('race-raw-bar').style.width = (100 * raw.stats.bytesScanned) / maxB + '%';
    $('race-cur-bar').style.width = Math.max(1.5, (100 * cur.stats.bytesScanned) / maxB) + '%';
    $('race-raw-num').textContent = `${fmtBytes(raw.stats.bytesScanned)} · ${fmtMs(raw.stats.engineMs)}`;
    $('race-cur-num').textContent = `${fmtBytes(cur.stats.bytesScanned)} · ${fmtMs(cur.stats.engineMs)}`;
    const ratio = raw.stats.bytesScanned / Math.max(1, cur.stats.bytesScanned);
    $('race-verdict').textContent =
      `Same rows, same answer: the curated Parquet scanned ${ratio.toFixed(0)}× less data` +
      (raw.stats.engineMs > cur.stats.engineMs ? ` and finished ${(raw.stats.engineMs / Math.max(1, cur.stats.engineMs)).toFixed(1)}× faster.` : '.') +
      (raw.cached || cur.cached ? ' (Served from cache — stats are from the recorded live runs.)' : '');
    $('race-result').hidden = false;
  } catch (err) {
    $('race-error').textContent = err.message;
    $('race-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run both in Athena';
  }
});

/* ---- boot ---- */
loadSummary().catch((err) => {
  $('dash-note').textContent = `Dashboard unavailable: ${err.message}`;
});
loadCatalog().catch(() => {});
