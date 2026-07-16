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
      (trace.meta.simulate === 'fail' ? ' · poisoned' : '');
    const settled = isSettled(trace.meta, trace.hops);
    $('#watching').textContent = settled
      ? `${label} — settled (${trace.hops.length} hops)`
      : `${label} — watching live…`;

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
}

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
    feed.innerHTML = '<p class="muted">Nothing yet — the next heartbeat is at most 30 minutes out, or send your own above.</p>';
    return;
  }
  feed.innerHTML = data.requests
    .map((r) => {
      const badges = [`<span class="badge cat">${esc(r.category)}</span>`];
      if (r.priority === 'urgent') badges.push('<span class="badge urgent">urgent</span>');
      if (r.status === 'dead-lettered') badges.push('<span class="badge dead">dead-lettered</span>');
      if (r.status === 'recovered') badges.push('<span class="badge cat">recovered</span>');
      if (r.origin === 'heartbeat') badges.push('<span class="badge hb">heartbeat</span>');
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

// ---------- boot ----------

loadStats();
loadFeed();
setInterval(loadStats, 10000);
setInterval(loadFeed, 8000);
