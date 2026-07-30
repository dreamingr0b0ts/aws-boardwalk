// Alpenglow Service Dispatch — live mesh dashboard.
// Everything rendered here is read back from the trace the event actually
// left behind (DynamoDB via /api); nothing is animated on faith.

const $ = (sel) => document.querySelector(sel);

const state = {
  currentId: null, // request being watched
  pollTimer: null,
  pollUntil: 0,
  meta: null,
};

// ---------- mesh map ----------

const ALL_NODES = () => document.querySelectorAll('.node[data-node]');

function resetMap() {
  ALL_NODES().forEach((n) => n.classList.remove('lit', 'done', 'fail'));
  $('#retry-note').hidden = true;
}

function mark(id, cls) {
  const el = document.querySelector(`.node[data-node="${id}"]`);
  if (!el) return;
  el.classList.remove('lit', 'done', 'fail');
  if (cls) el.classList.add(cls);
}

// Which map nodes each hop lights up. `d` is the department (hop.actor).
function applyHop(hop) {
  const d = hop.actor;
  switch (hop.hop) {
    case 'published':
      mark('api', 'done'); mark('bus', 'done'); break;
    case 'dequeued':
      mark(`rule-${d}`, 'done'); mark(`queue-${d}`, 'done'); mark(`worker-${d}`, 'lit'); break;
    case 'processed':
      mark(`worker-${d}`, 'done'); break;
    case 'attempt-failed':
      mark(`rule-${d}`, 'done'); mark(`queue-${d}`, 'done'); mark(`worker-${d}`, 'fail'); break;
    case 'dead-lettered':
      mark(`worker-${d}`, 'fail'); mark('dlq', 'fail'); break;
    case 'recovered':
      mark(`worker-${d}`, 'done'); mark('dlq', null); break;
    case 'notified':
      mark('rule-all', 'done'); mark('sns', 'done'); mark('notifier', 'done'); break;
    case 'audit-logged':
      mark('rule-all', 'done'); mark('sns', 'done'); mark('audit', 'done'); break;
    case 'sfn-triage':
      mark('rule-urgent', 'done'); mark('sfn-triage', 'done'); break;
    case 'sfn-dispatch-attempt':
      mark('sfn-dispatch', hop.note?.includes('attempt 1:') ? 'fail' : 'lit'); break;
    case 'sfn-dispatched':
      mark('sfn-dispatch', 'done'); $('#retry-note').hidden = false; break;
    case 'sfn-resolved':
      mark('sfn-resolve', 'done'); break;
  }
}

const FAIL_HOPS = new Set(['attempt-failed', 'dead-lettered']);

function renderTimeline(hops) {
  const list = $('#timeline');
  if (!hops.length) {
    list.innerHTML = '<li class="muted">Waiting for the first hop…</li>';
    return;
  }
  const t0 = new Date(hops[0].at).getTime();
  list.innerHTML = hops
    .map((h) => {
      const dt = new Date(h.at).getTime() - t0;
      const cls = FAIL_HOPS.has(h.hop) ? ' class="fail"' : '';
      return `<li${cls}><span class="h">${esc(h.hop)}</span><span class="n">${esc(h.note ?? '')}</span><span class="t">+${(dt / 1000).toFixed(1)}s</span></li>`;
    })
    .join('');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A trace is "settled" when every fan-out path it should touch has reported.
function isSettled(meta, hops) {
  const seen = new Set(hops.map((h) => h.hop));
  if (!seen.has('notified') || !seen.has('audit-logged')) return false;
  if (meta.priority === 'urgent' && !seen.has('sfn-resolved') && meta.escalation !== 'failed') return false;
  if (meta.simulate === 'fail') return seen.has('dead-lettered') || seen.has('recovered');
  return seen.has('processed');
}

// ---------- watching a request ----------

async function watch(requestId, { fresh } = { fresh: false }) {
  clearInterval(state.pollTimer);
  state.currentId = requestId;
  state.pollUntil = Date.now() + 3 * 60 * 1000;
  if (fresh) {
    resetMap();
    renderTimeline([]);
  }
  document.querySelectorAll('.req-row').forEach((r) =>
    r.classList.toggle('selected', r.dataset.id === requestId));

  const tick = async () => {
    let trace;
    try {
      const res = await fetch(`/api/requests/${requestId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      trace = await res.json();
    } catch {
      return; // transient — next tick retries
    }
    if (state.currentId !== requestId) return;

    state.meta = trace.meta;
    resetMap();
    trace.hops.forEach(applyHop);
    renderTimeline(trace.hops);

    const label = `${trace.meta.shortId} · ${trace.meta.category} · ${trace.meta.priority}` +
      (trace.meta.simulate === 'fail' ? ' · poisoned' : '') +
      (trace.meta.origin === 'replay' ? ` · second section of ${trace.meta.replayOf ?? '?'}` : '');
    const settled = isSettled(trace.meta, trace.hops);
    $('#watching').textContent = settled
      ? `${label} · settled (${trace.hops.length} hops)`
      : `${label} · watching live…`;

    if (settled || Date.now() > state.pollUntil) {
      clearInterval(state.pollTimer);
      if (trace.meta.status === 'dead-lettered') loadStats(); // show the new DLQ depth promptly
    }
  };

  await tick();
  state.pollTimer = setInterval(tick, 1500);
}

// ---------- submit ----------

$('#submit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submit-btn');
  const errEl = $('#submit-error');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    const body = {
      category: new FormData(e.target).get('category'),
      priority: $('#urgent').checked ? 'urgent' : 'normal',
      simulate: $('#poison').checked ? 'fail' : 'none',
      description: $('#description').value.trim(),
    };
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    $('#description').value = '';
    await watch(data.requestId, { fresh: true });
    document.querySelector('#mesh').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(loadFeed, 800);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- stats + DLQ strip ----------

let dlqDepths = {}; // latest per-department DLQ depths, for the bad-order card reader

async function loadStats() {
  let stats;
  try {
    stats = await (await fetch('/api/stats')).json();
  } catch {
    return;
  }
  const t = stats.totals ?? {};
  $('#stat-events').textContent = t.events ?? 0;
  $('#stat-notifications').textContent = t.notifications ?? 0;
  $('#stat-retries').textContent = t.retries ?? 0;
  $('#stat-dlq').textContent = stats.dlq.total;

  dlqDepths = stats.dlq.depths;
  const depths = Object.entries(stats.dlq.depths).filter(([, n]) => n > 0);
  $('#dlq-detail').textContent = depths.length
    ? depths.map(([d, n]) => `${d}: ${n}`).join(' · ')
    : 'all empty';
  const dlqNode = document.querySelector('.node[data-node="dlq"]');
  if (stats.dlq.total > 0) dlqNode.classList.add('fail');
  else dlqNode.classList.remove('fail');

  $('#dlq-actions').innerHTML = depths
    .map(([d]) => `<button type="button" data-redrive="${d}">Redrive ${d} ↩</button>`)
    .join('');

  // The card reader only makes sense when the rip track holds something.
  $('#boc-btn').hidden = stats.dlq.total === 0;
  if (stats.dlq.total === 0) $('#boc').hidden = true;
}

// ---------- bad-order cards: peek the DLQs without consuming them ----------

async function loadCards() {
  const box = $('#boc-cards');
  const depts = Object.entries(dlqDepths).filter(([, n]) => n > 0).map(([d]) => d);
  if (!depts.length) return;
  box.innerHTML = '<p class="muted">Walking the rip track…</p>';
  let all = [];
  try {
    const results = await Promise.all(depts.map(async (d) => (await fetch(`/api/dlq/${d}`)).json()));
    all = results.flatMap((r) => (r.cards ?? []).map((c) => ({ ...c, queue: r.queue })));
  } catch {
    box.innerHTML = '<p class="muted">Could not read the cards; try again.</p>';
    return;
  }
  if (!all.length) {
    box.innerHTML = '<p class="muted">No cards came back on that reading (a short poll can sample past a car). Read again.</p>';
    return;
  }
  box.innerHTML = all
    .map((c) => `<button type="button" class="boc-card" data-id="${esc(c.requestId ?? '')}">
      <span class="boc-head"><span class="id">${esc(c.shortId ?? 'CAR')}</span>
        <span class="desc">${esc(c.description ?? '')}</span></span>
      <span class="boc-meta">
        <span><b>${c.receiveCount}</b> deliveries (incl. readings)</span>
        ${c.sourceQueue ? `<span>off <b>${esc(c.sourceQueue)}</b></span>` : ''}
        ${c.sentAt ? `<span>waybilled <b>${esc(age(c.sentAt))}</b></span>` : ''}
        ${c.replayOf ? `<span>second section of <b>${esc(c.replayOf)}</b></span>` : ''}
      </span>
    </button>`)
    .join('');
}

$('#boc-btn').addEventListener('click', () => {
  const boc = $('#boc');
  boc.hidden = !boc.hidden;
  if (!boc.hidden) loadCards();
});

$('#boc-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.boc-card');
  if (card?.dataset.id) watch(card.dataset.id, { fresh: true });
});

document.querySelector('#dlq-actions').addEventListener('click', async (e) => {
  const dept = e.target.dataset?.redrive;
  if (!dept) return;
  e.target.disabled = true;
  try {
    await fetch('/api/redrive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queue: dept }),
    });
    // Keep watching the current request so the "recovered" hop shows up live.
    if (state.currentId) watch(state.currentId, { fresh: false });
    setTimeout(loadStats, 4000);
  } finally {
    setTimeout(() => loadStats(), 1500);
  }
});

// ---------- activity feed ----------

function age(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function loadFeed() {
  let data;
  try {
    data = await (await fetch('/api/requests')).json();
  } catch {
    return;
  }
  const feed = $('#feed');
  if (!data.requests.length) {
    feed.innerHTML = '<p class="muted">Nothing yet. The next scheduled heartbeat is at most 30 minutes out, or send your own above.</p>';
    return;
  }
  feed.innerHTML = data.requests
    .map((r) => {
      const badges = [`<span class="badge cat">${esc(r.category)}</span>`];
      if (r.priority === 'urgent') badges.push('<span class="badge urgent">urgent</span>');
      if (r.status === 'dead-lettered') badges.push('<span class="badge dead">dead-lettered</span>');
      if (r.status === 'recovered') badges.push('<span class="badge cat">recovered</span>');
      if (r.origin === 'heartbeat') badges.push('<span class="badge hb">heartbeat</span>');
      if (r.origin === 'replay') badges.push(`<span class="badge replay">2nd section${r.replayOf ? ` · ${esc(r.replayOf)}` : ''}</span>`);
      return `<button type="button" class="req-row${r.requestId === state.currentId ? ' selected' : ''}" data-id="${esc(r.requestId)}">
        <span class="id">${esc(r.shortId ?? '')}</span>${badges.join('')}
        <span class="desc">${esc(r.description ?? '')}</span>
        <span class="age">${age(r.createdAt)}</span>
      </button>`;
    })
    .join('');
}

$('#feed').addEventListener('click', (e) => {
  const row = e.target.closest('.req-row');
  if (row) watch(row.dataset.id, { fresh: true });
});

// ---------- interlocking tester ----------

const PT_EVENTS = {
  roads: {
    source: 'alpenglow.dispatch',
    'detail-type': 'service.request.submitted',
    detail: { category: 'roads', priority: 'normal', description: 'Pothole opening up on Larkspur Ave' },
  },
  urgent: {
    source: 'alpenglow.dispatch',
    'detail-type': 'service.request.submitted',
    detail: { category: 'parks', priority: 'urgent', description: 'Tree down across Ridgeline Trail' },
  },
  foreign: {
    source: 'neighboring.county',
    'detail-type': 'mutual.aid.request',
    detail: { category: 'roads', priority: 'urgent', description: 'Rockslide on the canyon road' },
  },
};

const PT_PATTERNS = {
  category: { source: ['alpenglow.dispatch'], detail: { category: ['roads', 'utilities'] } },
  urgent: { source: ['alpenglow.dispatch'], detail: { priority: ['urgent'] } },
  prefix: { source: [{ prefix: 'alpenglow.' }] },
  'anything-but': { source: ['alpenglow.dispatch'], detail: { category: [{ 'anything-but': ['parks'] }] } },
};

const fmt = (o) => JSON.stringify(o, null, 2);
$('#pt-event').value = fmt(PT_EVENTS.roads);
$('#pt-pattern').value = fmt(PT_PATTERNS.category);

document.querySelectorAll('[data-pt-event]').forEach((b) =>
  b.addEventListener('click', () => { $('#pt-event').value = fmt(PT_EVENTS[b.dataset.ptEvent]); }));
document.querySelectorAll('[data-pt-pattern]').forEach((b) =>
  b.addEventListener('click', () => { $('#pt-pattern').value = fmt(PT_PATTERNS[b.dataset.ptPattern]); }));

$('#pt-btn').addEventListener('click', async () => {
  const btn = $('#pt-btn');
  const errEl = $('#pt-error');
  const resEl = $('#pt-result');
  errEl.hidden = true;
  resEl.hidden = true;
  $('#pt-rules').hidden = true;

  let evt, pattern;
  try {
    evt = JSON.parse($('#pt-event').value);
  } catch (e) {
    errEl.textContent = `The event is not valid JSON. ${e.message}`;
    errEl.hidden = false;
    return;
  }
  try {
    pattern = JSON.parse($('#pt-pattern').value);
  } catch (e) {
    errEl.textContent = `The pattern is not valid JSON. ${e.message}`;
    errEl.hidden = false;
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch('/api/pattern-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: evt, pattern }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    resEl.className = `aspect ${data.matched ? 'clear' : 'stop'}`;
    resEl.textContent = data.matched ? 'Clear · the pattern matches' : 'Stop · no match';
    resEl.hidden = false;
    $('#pt-rule-chips').innerHTML = data.rules
      .map((r) => `<span class="rule-chip${r.matched ? ' on' : ''}">${esc(r.name)} <small>${esc(r.description)}</small></span>`)
      .join('');
    $('#pt-rules').hidden = false;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- the block order: standard vs FIFO race ----------

const raceState = { id: null, timer: null };

function renderTrack(el, arrivals, cars) {
  const boxes = arrivals.map((a) =>
    `<span class="car ${a.seq === a.pos ? 'ok' : 'ooo'}" title="car ${a.seq}, arrived ${a.pos}">${a.seq}</span>`);
  for (let i = arrivals.length; i < cars; i += 1) boxes.push('<span class="car ghost">·</span>');
  el.innerHTML = boxes.join('');
}

function renderRace(data) {
  const cars = data.meta.cars ?? 10;
  renderTrack($('#race-std'), data.arrivals.standard, cars);
  renderTrack($('#race-fifo'), data.arrivals.fifo, cars);

  const inversions = data.arrivals.standard.filter((a) => a.seq !== a.pos).length;
  const stdDone = data.arrivals.standard.length >= cars;
  $('#race-std-note').innerHTML = stdDone
    ? (inversions
      ? `<span class="warn">${inversions} cars arrived out of block order.</span> Standard queues promise delivery, not sequence.`
      : 'This cut happened to hold its order. Standard queues make no promise of it; send another cut and compare.')
    : `${data.arrivals.standard.length} of ${cars} cars in…`;

  const fifoDone = data.arrivals.fifo.length >= cars;
  const dedupNote = data.meta.dupAbsorbed
    ? ` <span class="good">Car ${data.meta.dupSeq} was offered twice; SQS answered the duplicate send with the original MessageId and delivered it once.</span>`
    : '';
  $('#race-fifo-note').innerHTML = fifoDone
    ? `<span class="good">All ${cars} cars in strict block order.</span> One message group, delivered one at a time.${dedupNote}`
    : `${data.arrivals.fifo.length} of ${cars} cars in, in order…`;

  return stdDone && fifoDone;
}

$('#race-btn').addEventListener('click', async () => {
  const btn = $('#race-btn');
  const errEl = $('#race-error');
  errEl.hidden = true;
  btn.disabled = true;
  clearInterval(raceState.timer);
  try {
    const res = await fetch('/api/race', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    raceState.id = data.raceId;
    $('#race-board').hidden = false;
    renderTrack($('#race-std'), [], 10);
    renderTrack($('#race-fifo'), [], 10);
    $('#race-std-note').textContent = 'Cut sent. Waiting on the first arrivals…';
    $('#race-fifo-note').textContent = '';

    const until = Date.now() + 45 * 1000;
    raceState.timer = setInterval(async () => {
      let trace;
      try {
        const r = await fetch(`/api/race/${raceState.id}`);
        if (!r.ok) throw new Error();
        trace = await r.json();
      } catch {
        return; // transient; next tick retries
      }
      const settled = renderRace(trace);
      if (settled || Date.now() > until) {
        clearInterval(raceState.timer);
        btn.disabled = false;
        btn.textContent = 'Send another cut';
      }
    }, 800);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
  }
});

// ---------- second section: archive replay ----------

const replayState = { polling: false };

function fmtBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function loadReplay() {
  let data;
  try {
    data = await (await fetch('/api/replay')).json();
  } catch {
    return;
  }
  $('#replay-archive').textContent =
    `The vault holds ${data.archive.events} events from the last ${data.archive.retentionDays ?? 2} days (${fmtBytes(data.archive.sizeBytes)}).`;

  const statusEl = $('#replay-status');
  const btn = $('#replay-btn');
  if (data.current) {
    statusEl.className = 'mono-line running';
    statusEl.textContent = `Second section ${data.current.replayName} is ${String(data.current.state).toLowerCase()} over the last ${data.current.window}. Re-run events are lighting the arrivals board with 2nd-section badges.`;
    statusEl.hidden = false;
    btn.disabled = true;
    if (!replayState.polling) {
      replayState.polling = true;
      const tick = setInterval(async () => {
        await loadReplay();
        if (!replayState.polling) clearInterval(tick);
      }, 2500);
    }
  } else {
    if (replayState.polling) {
      // A run just finished: pull the feed and stats so its second sections show up.
      replayState.polling = false;
      loadFeed();
      loadStats();
    }
    btn.disabled = false;
    if (data.last) {
      statusEl.className = `mono-line ${data.last.state === 'COMPLETED' ? 'done' : ''}`;
      statusEl.textContent = `Last second section (${data.last.window} window) ${String(data.last.state).toLowerCase()} at ${new Date(data.last.finishedAt).toLocaleTimeString()}. Its re-runs carry 2nd-section badges on the arrivals board.`;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }
}

$('#replay-btn').addEventListener('click', async () => {
  const errEl = $('#replay-error');
  errEl.hidden = true;
  $('#replay-btn').disabled = true;
  try {
    const picked = document.querySelector('#replay-window input:checked')?.value ?? '1h';
    const res = await fetch('/api/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: picked }),
    });
    const data = await res.json();
    if (!res.ok && res.status !== 409) throw new Error(data.message ?? `HTTP ${res.status}`);
    // 409 means one is already running; either way, attach to what's on the board.
    await loadReplay();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    $('#replay-btn').disabled = false;
  }
});

// ---------- boot ----------

loadStats();
loadFeed();
loadReplay();
setInterval(loadStats, 10000);
setInterval(loadFeed, 8000);
