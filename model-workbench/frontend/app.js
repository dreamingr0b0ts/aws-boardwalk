// Alpenglow Model Workbench — zero-build frontend.
// Auth is a plain Cognito InitiateAuth call (USER_PASSWORD_AUTH over TLS), so
// no SDK or bundler is needed; the API is same-origin behind CloudFront /api/*.
// The bench works in two tiers: visitors run scenario prompts against the
// /api/public/* routes (5/day, no sign-in); signing in unlocks custom prompts,
// the higher daily limit, and the audit ledger.

const $ = (id) => document.getElementById(id);

let config = null; // { region, userPoolClientId } written at publish time
let info = null; // /api/public/info payload
let idToken = sessionStorage.getItem('fmw.idToken') || null;
let tokenExp = Number(sessionStorage.getItem('fmw.exp') || 0);

const authed = () => Boolean(idToken) && tokenExp * 1000 > Date.now() + 60_000;

init();

async function init() {
  config = await (await fetch('/config.json')).json();
  await loadPublicInfo();
  $('login-form').addEventListener('submit', onLogin);
  $('logout-btn').addEventListener('click', logout);
  $('run-btn').addEventListener('click', onRun);
  $('scenario').addEventListener('change', onScenarioChange);
  $('temperature').addEventListener('input', () => ($('temperature-out').textContent = $('temperature').value));
  applyTier();
  loadRecords();
}

// Reshape the bench for the current tier: which prompt sources exist, the
// token ceiling, which quota endpoint feeds the meter, ledger vs upsell.
function applyTier() {
  const a = authed();
  $('login-panel').hidden = a;
  $('logout-btn').hidden = !a;
  $('bench-mode').hidden = a;
  $('ledger-upsell').hidden = a;
  if (!a) $('ledger-list').replaceChildren();

  syncCustomOption(a);

  const cap = a ? (info?.limits?.maxOutputTokens ?? 500) : (info?.limits?.anonMaxOutputTokens ?? 300);
  const mt = $('max-tokens');
  mt.max = String(cap);
  if (Number(mt.value) > cap) mt.value = String(cap);

  refreshQuota();
  if (a) refreshLedger();
}

function syncCustomOption(a) {
  const sel = $('scenario');
  let opt = [...sel.options].find((o) => o.value === '');
  if (a && !opt) {
    opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Custom prompt…';
    sel.appendChild(opt);
  } else if (!a && opt) {
    if (sel.value === '') sel.value = info?.scenarios[0]?.id ?? '';
    opt.remove();
    onScenarioChange();
  }
}

async function loadPublicInfo() {
  try {
    info = await (await fetch('/api/public/info')).json();
  } catch {
    info = { models: [], scenarios: [], stats: {}, limits: {} };
  }
  $('stat-scenarios').textContent = info.scenarios.length || '–';
  $('stat-runs').textContent = `${info.stats.globalUsed ?? 0}/${info.limits.globalDailyRuns ?? '–'}`;

  const roster = $('roster');
  roster.replaceChildren();
  for (const m of info.models) {
    const card = document.createElement('div');
    card.className = 'model-card';
    card.dataset.key = m.key;
    const vendor = document.createElement('div');
    vendor.className = 'vendor';
    vendor.textContent = m.vendor;
    const name = document.createElement('h3');
    name.textContent = m.label;
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = `$${m.inPerM}/M in · $${m.outPerM}/M out`;
    card.append(vendor, name, price);
    roster.appendChild(card);
  }

  const list = $('scenario-list');
  list.replaceChildren();
  for (const s of info.scenarios) {
    const li = document.createElement('li');
    const b = document.createElement('strong');
    b.textContent = `${s.title}: `;
    li.append(b, document.createTextNode(s.blurb));
    list.appendChild(li);
  }

  // workbench controls (the custom-prompt option is added by tier — see
  // syncCustomOption; visitors are scenario-only)
  const sel = $('scenario');
  sel.replaceChildren();
  for (const s of info.scenarios) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    sel.appendChild(opt);
  }
  onScenarioChange();

  const pick = $('model-pick');
  pick.replaceChildren();
  for (const m of info.models) {
    const label = document.createElement('label');
    label.dataset.key = m.key;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = m.key;
    box.checked = true;
    label.append(box, document.createTextNode(`${m.label} · ${m.vendor}`));
    pick.appendChild(label);
  }
}

function onScenarioChange() {
  const id = $('scenario').value;
  const s = info?.scenarios.find((x) => x.id === id);
  $('scenario-blurb').textContent = s?.blurb ?? 'Your prompt goes to every selected model verbatim (2,000 character cap).';
  $('custom-prompt').hidden = Boolean(s);
}

// ---- auth ------------------------------------------------------------------

async function onLogin(e) {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').hidden = true;
  try {
    const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.userPoolClientId,
        AuthParameters: {
          USERNAME: $('login-email').value.trim(),
          PASSWORD: $('login-password').value,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.AuthenticationResult) throw new Error(data.message || 'Sign-in failed');
    idToken = data.AuthenticationResult.IdToken;
    tokenExp = JSON.parse(atob(idToken.split('.')[1])).exp;
    sessionStorage.setItem('fmw.idToken', idToken);
    sessionStorage.setItem('fmw.exp', String(tokenExp));
    $('login-password').value = '';
    applyTier();
  } catch (err) {
    const el = $('login-error');
    el.textContent = err.message === 'Incorrect username or password.' ? 'Incorrect email or password.' : `Could not sign in: ${err.message}`;
    el.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function logout() {
  sessionStorage.removeItem('fmw.idToken');
  sessionStorage.removeItem('fmw.exp');
  idToken = null;
  applyTier(); // back to the visitor tier, bench stays usable
}

async function api(method, path, body) {
  if (!authed()) {
    logout();
    throw new Error('Session expired. Please sign in again.');
  }
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${idToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired. Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

// The visitor tier: same-origin, no Authorization header, /api/public/* only.
async function publicApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

// ---- running ---------------------------------------------------------------

async function onRun() {
  const btn = $('run-btn');
  $('run-error').hidden = true;
  const models = [...$('model-pick').querySelectorAll('input:checked')].map((b) => b.value);
  if (!models.length) return showRunError('Pick at least one model.');
  const scenarioId = $('scenario').value || null;
  const prompt = scenarioId ? undefined : $('custom-prompt').value.trim();
  if (!scenarioId && !prompt) return showRunError('Pick a scenario or write a prompt.');

  btn.disabled = true;
  btn.textContent = `Running on ${models.length} model${models.length > 1 ? 's' : ''}…`;
  renderPending(models);
  try {
    const a = authed();
    const payload = {
      ...(scenarioId ? { scenarioId } : { prompt }),
      models,
      temperature: Number($('temperature').value),
      maxTokens: Number($('max-tokens').value),
      guardrail: $('guardrail-box').checked,
    };
    const res = a ? await api('POST', '/api/run', payload) : await publicApi('POST', '/api/public/run', payload);
    renderResults(res);
    renderQuota(res.quota);
    if (a) refreshLedger();
  } catch (err) {
    $('results').replaceChildren();
    showRunError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run on selected models';
  }
}

function showRunError(msg) {
  const el = $('run-error');
  el.textContent = msg;
  el.hidden = false;
}

const pill = (text, cls = '') => {
  const s = document.createElement('span');
  s.className = `sev ${cls}`;
  s.textContent = text;
  return s;
};

function renderPending(models) {
  const grid = $('results');
  grid.replaceChildren();
  $('compare').replaceChildren();
  for (const key of models) {
    const m = info.models.find((x) => x.key === key);
    const card = document.createElement('div');
    card.className = 'res-card';
    card.dataset.key = key;
    card.innerHTML = `<div class="head"><strong>${m?.label ?? key}</strong><span class="muted small">running…</span></div>`;
    grid.appendChild(card);
  }
}

// Deterministic grader for the structured-extraction scenario: does the raw
// answer parse as JSON on its own, and does it match the schema the system
// prompt demanded? Plain code, zero cost, no judgment calls.
function gradeStrictJson(text) {
  const kinds = ['building', 'electrical', 'plumbing', 'mechanical', 'solar', 'demolition'];
  const schemaError = (o) => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return 'not an object';
    if (typeof o.applicant !== 'string') return 'applicant';
    if (typeof o.address !== 'string') return 'address';
    if (!kinds.includes(o.permit_type)) return 'permit_type';
    if (typeof o.valuation_usd !== 'number') return 'valuation_usd';
    if (!(o.contractor_license === null || typeof o.contractor_license === 'string')) return 'contractor_license';
    if (!Array.isArray(o.flags) || !o.flags.every((f) => typeof f === 'string')) return 'flags';
    return null;
  };

  let obj = null;
  let mode = 'strict';
  try {
    obj = JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { obj = JSON.parse(fenced[1]); mode = 'fenced'; } catch { /* fall through */ }
    }
    if (!obj) {
      const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      if (braced) {
        try { obj = JSON.parse(braced); mode = 'wrapped'; } catch { /* fall through */ }
      }
    }
  }
  if (!obj) return [['not JSON', 'bad']];
  const pills = mode === 'strict' ? [['strict JSON', 'ok']] : [[mode === 'fenced' ? 'JSON in fences' : 'JSON in chat wrapper', 'warn']];
  const err = schemaError(obj);
  pills.push(err ? [`schema: ${err}`, 'bad'] : ['schema valid', 'ok']);
  return pills;
}

function renderResults(res) {
  const scen = info?.scenarios.find((s) => s.id === res.scenarioId);
  const judgeScore = (key) => (res.judge?.ok ? res.judge.scores.find((s) => s.key === key) : null);

  const grid = $('results');
  grid.replaceChildren();
  for (const r of res.results) {
    const card = document.createElement('div');
    card.className = `res-card${r.ok ? '' : ' err'}`;
    card.dataset.key = r.key;

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('strong');
    name.textContent = r.label;
    const vendor = document.createElement('span');
    vendor.className = 'muted small';
    vendor.textContent = r.vendor;
    head.append(name, vendor);

    const metrics = document.createElement('div');
    metrics.className = 'metrics';
    if (r.ok) {
      metrics.append(
        pill(`${(r.latencyMs / 1000).toFixed(1)}s`),
        pill(`${r.usage.inputTokens}→${r.usage.outputTokens} tok`),
        pill(`$${r.costUsd.toFixed(5)}`, 'ok'),
      );
      if (r.stopReason && r.stopReason !== 'end_turn' && r.stopReason !== 'guardrail_intervened')
        metrics.append(pill(r.stopReason, 'warn'));
      if (r.guardrail?.applied) {
        if (r.guardrail.intervened) metrics.append(pill('guardrail: blocked', 'bad'));
        else if (r.guardrail.masked > 0) metrics.append(pill(`guardrail: ${r.guardrail.masked} masked`, 'warn'));
        else metrics.append(pill('guardrail: clean pass', 'ok'));
      }
      if (scen?.check === 'strict-json') for (const [t, cls] of gradeStrictJson(r.text)) metrics.append(pill(t, cls));
      const js = judgeScore(r.key);
      if (js) metrics.append(pill(`judge ${js.score}/10`, js.score >= 8 ? 'ok' : js.score <= 4 ? 'bad' : ''));
    } else {
      metrics.append(pill(r.error ?? 'failed', 'bad'));
    }

    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.textContent = r.ok ? r.text : 'The invocation failed. See the error badge above.';

    card.append(head, metrics, answer);
    const js = r.ok ? judgeScore(r.key) : null;
    if (js?.note) {
      const note = document.createElement('div');
      note.className = 'muted small';
      note.textContent = `judge: ${js.note}`;
      card.appendChild(note);
    }
    grid.appendChild(card);
  }

  const okResults = res.results.filter((r) => r.ok);
  const strip = $('compare');
  strip.replaceChildren();
  if (okResults.length > 1) {
    const fastest = okResults.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b));
    const cheapest = okResults.reduce((a, b) => (a.costUsd < b.costUsd ? a : b));
    const priciest = okResults.reduce((a, b) => (a.costUsd > b.costUsd ? a : b));
    strip.append(
      pill(`fastest: ${fastest.label}`, 'ok'),
      pill(`cheapest: ${cheapest.label} ($${cheapest.costUsd.toFixed(5)})`, 'ok'),
      pill(`${(priciest.costUsd / Math.max(cheapest.costUsd, 1e-9)).toFixed(0)}× cost spread`, 'warn'),
      pill(`whole run: $${res.totalCostUsd.toFixed(5)}`),
    );
    if (res.judge?.ok) {
      const top = [...res.judge.scores].sort((a, b) => b.score - a.score)[0];
      const topModel = info?.models.find((m) => m.key === top.key);
      strip.append(pill(`judge's pick: ${topModel?.label ?? top.key} (${top.score}/10)`, 'ok'));
    }
  }

  const jl = $('judge-line');
  if (res.judge?.ok) {
    const jm = info?.models.find((m) => m.key === res.judge.model);
    jl.textContent =
      `Blind judge: ${jm?.label ?? res.judge.model} scored ${res.judge.scores.length} shuffled, unattributed answers against the rubric ` +
      `(${(res.judge.latencyMs / 1000).toFixed(1)}s, $${res.judge.costUsd.toFixed(5)}, included in the run total).`;
    jl.hidden = false;
  } else if (res.judge) {
    jl.textContent = 'The judge pass did not complete this run; scores are omitted.';
    jl.hidden = false;
  } else {
    jl.hidden = true;
  }
}

// ---- quota + ledger --------------------------------------------------------

async function refreshQuota() {
  try {
    renderQuota(authed() ? await api('GET', '/api/me/quota') : await publicApi('GET', '/api/public/quota'));
  } catch {
    /* non-fatal */
  }
}

function renderQuota(q) {
  const yours =
    q.tier === 'visitor'
      ? `Free visitor runs today: ${q.userUsed}/${q.userLimit} (sign in for ${info?.limits?.userDailyRuns ?? 30}/day)`
      : `Your runs today: ${q.userUsed}/${q.userLimit}`;
  $('quota-line').textContent =
    `${yours} · demo-wide budget: ${q.globalUsed}/${q.globalLimit} · each run invokes every selected model once`;
}

async function refreshLedger() {
  let data;
  try {
    data = await api('GET', '/api/runs');
  } catch {
    return;
  }
  const list = $('ledger-list');
  list.replaceChildren();
  if (!data.runs.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'No runs yet today.';
    list.appendChild(p);
    return;
  }
  for (const run of data.runs) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `${run.at.slice(11, 19)} UTC · ${run.scenarioId} · ${run.results.length} models · $${(run.totalCostUsd ?? 0).toFixed(5)}`;
    det.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'fact';
    ul.style.marginTop = '8px';
    for (const r of run.results) {
      const m = info.models.find((x) => x.key === r.key);
      const li = document.createElement('li');
      li.className = r.ok ? 'ok' : 'no';
      li.dataset.key = r.key;
      const js = run.judge?.scores?.find((s) => s.key === r.key);
      li.textContent =
        `${m?.label ?? r.key}: ${r.inputTokens}→${r.outputTokens} tok, $${(r.costUsd ?? 0).toFixed(5)}, ` +
        `${(r.latencyMs / 1000).toFixed(1)}s (${r.stopReason ?? '–'})${js ? `, judge ${js.score}/10` : ''}` +
        `${r.guardrailMasked ? `, ${r.guardrailMasked} masked` : ''}`;
      ul.appendChild(li);
    }
    const meta = document.createElement('p');
    meta.className = 'muted small';
    meta.style.marginTop = '6px';
    meta.textContent = `temperature ${run.temperature} · maxTokens ${run.maxTokens}${run.guardrail ? ' · guardrail on' : ''} · prompt: "${run.promptPreview}…"`;
    det.append(ul, meta);
    list.appendChild(det);
  }
}

// ---- bench records ----------------------------------------------------------
// Thirty days of the ledger, drawn as one sparkline per model (median latency
// per day) plus the aggregate numbers as text and a table. Single series per
// card, model name as the direct label, values in ink rather than the series
// color; the channel color carries identity only.

const SVGNS = 'http://www.w3.org/2000/svg';
const fmtLat = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function sparkline(m, days, readout, summaryText) {
  const W = 240;
  const H = 56;
  const P = 6;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${m.label}: median latency per day over the last ${days.length} days`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const vals = m.p50Series;
  const nums = vals.filter((v) => v != null);
  const base = document.createElementNS(SVGNS, 'line');
  base.setAttribute('x1', P);
  base.setAttribute('x2', W - P);
  base.setAttribute('y1', H - P);
  base.setAttribute('y2', H - P);
  base.setAttribute('class', 'spark-base');
  svg.appendChild(base);
  if (!nums.length) return svg;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const x = (i) => (days.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (days.length - 1));
  const y = (v) => (hi === lo ? H / 2 : P + ((hi - v) * (H - 2 * P - 6)) / (hi - lo));

  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d.trim());
  path.setAttribute('class', 'spark-line');
  svg.appendChild(path);

  // isolated single-day points and the most recent point get a dot; drawn as
  // zero-length round-capped strokes so preserveAspectRatio="none" cannot
  // stretch them into ellipses
  vals.forEach((v, i) => {
    const isolated = v != null && vals[i - 1] == null && vals[i + 1] == null;
    const isLast = v != null && vals.slice(i + 1).every((n) => n == null);
    if (!isolated && !isLast) return;
    const dot = document.createElementNS(SVGNS, 'path');
    dot.setAttribute('d', `M${x(i).toFixed(1)},${y(v).toFixed(1)} l0.01,0`);
    dot.setAttribute('class', 'spark-dot');
    svg.appendChild(dot);
  });

  // hover strips: one wide hit target per day, readout does the talking
  days.forEach((day, i) => {
    const strip = document.createElementNS(SVGNS, 'rect');
    strip.setAttribute('x', (i === 0 ? 0 : (x(i) + x(i - 1)) / 2).toFixed(1));
    strip.setAttribute('width', (W / days.length + 1).toFixed(1));
    strip.setAttribute('y', 0);
    strip.setAttribute('height', H);
    strip.setAttribute('fill', 'transparent');
    strip.addEventListener('mouseenter', () => {
      readout.textContent =
        vals[i] == null ? `${fmtDay(day)} · no runs` : `${fmtDay(day)} · p50 ${fmtLat(vals[i])} · ${m.runSeries[i]} run${m.runSeries[i] === 1 ? '' : 's'}`;
    });
    strip.addEventListener('mouseleave', () => {
      readout.textContent = summaryText;
    });
    svg.appendChild(strip);
  });
  return svg;
}

async function loadRecords() {
  let data;
  try {
    data = await publicApi('GET', '/api/public/records');
  } catch {
    return; // the section stays quietly empty if the API is unreachable
  }
  const grid = $('records-grid');
  grid.replaceChildren();
  if (!data.totals.runs) {
    $('records-empty').hidden = false;
    return;
  }

  for (const m of data.models) {
    const card = document.createElement('div');
    card.className = 'rec-card';
    card.dataset.key = m.key;

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('strong');
    name.textContent = m.label;
    const vendor = document.createElement('span');
    vendor.className = 'muted small';
    vendor.textContent = m.vendor;
    head.append(name, vendor);

    const readout = document.createElement('div');
    readout.className = 'rec-readout muted small';
    const summaryText = m.runs
      ? `p50 ${fmtLat(m.p50LatencyMs)} · ${m.runs} runs · avg $${(m.avgCostUsd ?? 0).toFixed(5)}/run`
      : 'no runs in the window yet';
    readout.textContent = summaryText;

    card.append(head, sparkline(m, data.days, readout, summaryText), readout);
    grid.appendChild(card);
  }

  const table = $('records-table');
  table.replaceChildren();
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const h of ['Model', 'Runs', 'p50 latency', 'Avg cost/run', '30-day cost']) {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  const tbody = document.createElement('tbody');
  for (const m of data.models) {
    const tr = document.createElement('tr');
    for (const v of [m.label, m.runs, fmtLat(m.p50LatencyMs), m.avgCostUsd == null ? '–' : `$${m.avgCostUsd.toFixed(5)}`, `$${m.totalCostUsd.toFixed(4)}`]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const totals = document.createElement('tr');
  for (const v of ['All runs', data.totals.runs, '', '', `$${data.totals.costUsd.toFixed(4)}`]) {
    const td = document.createElement('td');
    td.textContent = String(v);
    totals.appendChild(td);
  }
  tbody.appendChild(totals);
  table.append(thead, tbody);
  $('records-table-wrap').hidden = false;
}
