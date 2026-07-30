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

/* ---- the depth chart: ZIP bubbles at Census centroids over county lines.
   Colorado is a lat/lon rectangle, so an equirectangular projection with a
   cos(mid-latitude) x-correction is honest at this scale. Single validated
   hue; magnitude rides on bubble AREA, and overlap alpha-compounds into the
   darker "deep water" reading. ---- */
function mapChart(mount, geo, rows) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of geo.counties)
    for (const poly of c.polys)
      for (const [lon, lat] of poly[0]) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const M = 12, W = 940;
  const innerW = W - 2 * M;
  const innerH = innerW * ((maxLat - minLat) / ((maxLon - minLon) * kx));
  const H = Math.round(innerH + 2 * M);
  const xPos = (lon) => M + innerW * ((lon - minLon) / (maxLon - minLon));
  const yPos = (lat) => M + innerH * ((maxLat - lat) / (maxLat - minLat));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const c of geo.counties) {
    const d = c.polys
      .map((poly) => poly.map((ring) => 'M' + ring.map(([lon, lat]) => `${xPos(lon).toFixed(1)},${yPos(lat).toFixed(1)}`).join('L') + 'Z').join(''))
      .join('');
    svg.append(el('path', { d, class: 'county' }));
  }

  const pts = rows
    .map(([zip, n, city]) => ({ zip, n: +n, city, ll: geo.zips[zip] }))
    .filter((p) => p.ll)
    .sort((a, b) => b.n - a.n);
  const maxN = pts[0]?.n ?? 1;
  for (const p of pts) {
    const r = Math.max(2.5, 30 * Math.sqrt(p.n / maxN));
    const c = el('circle', { cx: xPos(p.ll[0]).toFixed(1), cy: yPos(p.ll[1]).toFixed(1), r: r.toFixed(1), class: 'sounding' });
    hover(c, () => `${fmt(p.n)} in Good Standing<small>ZIP ${p.zip} · ${titleCase(p.city)}</small>`);
    svg.append(c);
  }

  // label the biggest anchors, halo over the bubbles: one per city, and only
  // where a label won't sit on an already-placed one (the Denver metro packs
  // several top ZIPs into a few pixels; distance beats rank for legibility)
  const seen = new Set();
  const placed = [];
  for (const p of pts) {
    if (placed.length >= 6) break;
    if (seen.has(p.city)) continue;
    const x = xPos(p.ll[0]), y = yPos(p.ll[1]) - 30 * Math.sqrt(p.n / maxN) - 5;
    if (placed.some(([px, py]) => Math.abs(px - x) < 110 && Math.abs(py - y) < 26)) continue;
    seen.add(p.city);
    placed.push([x, y]);
    svg.append(
      Object.assign(el('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': 'middle', class: 'city' }),
        { textContent: titleCase(p.city) })
    );
  }
  mount.replaceChildren(svg);
  return { plotted: pts.length, covered: pts.reduce((a, p) => a + p.n, 0), skipped: rows.length - pts.length };
}

/* ---- data plumbing ---- */
const TYPE_LABELS = {
  DLLC: 'Domestic LLC', DPC: 'Domestic profit corp', DNC: 'Domestic nonprofit',
  FLLC: 'Foreign LLC', FPC: 'Foreign profit corp', FNC: 'Foreign nonprofit',
  DLP: 'Domestic LP', DLLP: 'Domestic LLP', DLLLP: 'Domestic LLLP', FLP: 'Foreign LP',
  GP: 'General partnership', FO: 'Foreign other',
};
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

let MANIFEST = null;

async function renderMap(s) {
  if (!s.map_zips?.rows?.length) {
    $('map-note').textContent = 'The depth chart fills in after the next ETL run publishes its aggregate.';
    return;
  }
  const geo = await (await fetch('/geo/colorado.json')).json();
  const r = mapChart($('map-plot'), geo, s.map_zips.rows);
  $('map-cap').textContent =
    `${fmt(r.plotted)} ZIP codes plotted, covering ${fmt(r.covered)} entities in Good Standing. ` +
    `Not drawn: ZIPs with fewer than 10${r.skipped > 0 ? `, and ${fmt(r.skipped)} (mostly PO-box ZIPs) without a Census area centroid` : ''}.`;
}

async function loadSummary() {
  const res = await fetch('/api/summary');
  if (!res.ok) throw new Error((await res.json()).message ?? 'summary failed');
  const s = await res.json();
  const m = s.manifest;
  MANIFEST = m;
  renderMap(s).catch(() => {
    $('map-note').textContent = 'The depth chart could not load its geometry.';
  });

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
  $('q-glass').hidden = true;
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

function renderStats(r, p = 's', box = 'qstats') {
  $(p + '-scanned').textContent = 'scanned ' + fmtBytes(r.stats.bytesScanned);
  $(p + '-time').textContent = 'engine ' + fmtMs(r.stats.engineMs);
  $(p + '-cost').textContent = fmtCost(r.stats.estCostUsd);
  const c = $(p + '-cache');
  c.textContent = r.cached ? 'cache hit: Athena not re-run' : 'live Athena execution';
  c.classList.toggle('hit', r.cached);
  $(box).hidden = false;
}

/* ---- under the glass: what the engine actually did ----
   Two exhibits per live run: which decade partitions of the curated zone the
   query was eligible to read (drawn to scale from the manifest's per-partition
   sizes), and the engine's own stage tree from GetQueryRuntimeStatistics. */
function renderGlass(mount, r) {
  mount.replaceChildren();
  const h = document.createElement('p');
  h.className = 'glass-label';
  h.textContent = 'Under the glass';
  mount.append(h);

  const detail = MANIFEST?.curated?.partitionDetail;
  if (r.zone === 'raw') {
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = 'The raw zone has no partitions and no columns: one gzipped JSONL stream, so the engine decompressed and read every byte of every record.';
    mount.append(note);
  } else if (detail?.length) {
    const touched = new Set(r.decades ?? detail.map((p) => p.decade));
    const total = detail.reduce((a, p) => a + p.bytes, 0);
    const wrap = document.createElement('div');
    wrap.className = 'bands';
    let readB = 0;
    for (const p of detail) {
      const b = document.createElement('div');
      const on = touched.has(p.decade);
      if (on) readB += p.bytes;
      b.className = 'band' + (on ? ' on' : '');
      b.style.flexGrow = String(Math.max(p.bytes, total / 200));
      hover(b, () => `${on ? 'read' : 'skipped'}<small>decade=${p.decade} · ${fmtBytes(p.bytes)} of Parquet</small>`);
      wrap.append(b);
    }
    mount.append(wrap);
    const cap = document.createElement('p');
    cap.className = 'muted small';
    cap.textContent = r.decades
      ? `Partition pruning: the WHERE clause names the partition key, so ${touched.size} of ${detail.length} decade folders were eligible (${fmtBytes(readB)}); ${fmtBytes(total - readB)} of Parquet was never opened.`
      : `No decade filter on this one, so all ${detail.length} partitions were eligible. The saving came from the columnar layout instead: only the columns in the SELECT came off the disk.`;
    mount.append(cap);
  }

  if (r.runtime?.stages?.length) {
    const flow = document.createElement('div');
    flow.className = 'stageflow';
    r.runtime.stages.forEach((st, i) => {
      if (i > 0) {
        const a = document.createElement('span');
        a.className = 'arrow';
        a.setAttribute('aria-hidden', 'true');
        a.textContent = '→';
        flow.append(a);
      }
      const box = document.createElement('div');
      box.className = 'stage-box';
      box.innerHTML =
        `<span class="stage-name">Stage ${st.stage}${i === 0 ? ' · scan' : i === r.runtime.stages.length - 1 ? ' · output' : ''}</span>` +
        `<span class="stage-io">in ${fmtK(st.inputRows)} rows · ${fmtBytes(st.inputBytes)}</span>` +
        `<span class="stage-io">out ${fmtK(st.outputRows)} rows · ${fmtBytes(st.outputBytes)}</span>`;
      flow.append(box);
    });
    mount.append(flow);
    const tl = document.createElement('p');
    tl.className = 'muted small';
    const t = r.runtime.timeline;
    tl.textContent = `The engine's own account, stage by stage (distributed workers, source first). Timeline: queued ${fmtMs(t.queueMs)} · planned ${fmtMs(t.planningMs)} · executed ${fmtMs(t.engineMs)}.`;
    mount.append(tl);
  } else if (r.cached) {
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = 'This result came from the cache before the engine stats were recorded; a fresh run (after the cache expires) fills in the stage tree.';
    mount.append(note);
  }
  mount.hidden = false;
}

function renderTable(r, tbl = $('q-results')) {
  const numeric = r.columns.map((_, i) => r.rows.every((row) => /^-?[\d.]+$/.test(row[i] ?? '')));
  // years are numbers but not quantities: no thousands separators on them
  const yearlike = r.columns.map((c, i) =>
    /year/i.test(c) || r.rows.every((row) => /^(1[89]|20)\d{2}$/.test(row[i] ?? '')));
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
      td.textContent = numeric[i] && v !== '' && !yearlike[i] ? nf.format(+v) : v;
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
    renderGlass($('q-glass'), r);
  } catch (err) {
    $('q-error').textContent = err.message;
    $('q-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run in Athena';
  }
});

/* ---- drop a line: the name lookup ---- */
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  const btn = $('search-btn');
  btn.disabled = true;
  btn.textContent = 'Sounding…';
  $('search-error').hidden = true;
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? 'search failed');
    updateUsage(body.usage);
    $('search-found').textContent =
      body.totalMatches === 0
        ? `Nothing in the lake answers to "${body.q}". Fewer letters cast a wider net.`
        : `${fmt(body.totalMatches)} registration${body.totalMatches === 1 ? '' : 's'} answer${body.totalMatches === 1 ? 's' : ''} to "${body.q}"` +
          (body.totalMatches > body.rows.length ? `, showing the first ${body.rows.length} by name.` : '.');
    renderStats(body, 'f', 'search-stats');
    renderTable(body, $('search-results'));
    $('search-results').hidden = body.rows.length === 0;
    renderGlass($('search-glass'), body);
    $('search-out').hidden = false;
  } catch (err) {
    $('search-error').textContent = err.message;
    $('search-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search the lake';
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
      (raw.cached || cur.cached ? ' (Served from cache; stats are from the recorded live runs.)' : '');
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
