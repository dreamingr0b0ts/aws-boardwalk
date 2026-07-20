// Alpenglow Model Workbench — zero-build frontend.
// Auth is a plain Cognito InitiateAuth call (USER_PASSWORD_AUTH over TLS), so
// no SDK or bundler is needed; the API is same-origin behind CloudFront /api/*.

const $ = (id) => document.getElementById(id);

let config = null; // { region, userPoolClientId } written at publish time
let info = null; // /api/public/info payload
let idToken = sessionStorage.getItem('fmw.idToken') || null;
let tokenExp = Number(sessionStorage.getItem('fmw.exp') || 0);

init();

async function init() {
  config = await (await fetch('/config.json')).json();
  await loadPublicInfo();
  $('login-form').addEventListener('submit', onLogin);
  $('logout-btn').addEventListener('click', logout);
  $('run-btn').addEventListener('click', onRun);
  $('scenario').addEventListener('change', onScenarioChange);
  $('temperature').addEventListener('input', () => ($('temperature-out').textContent = $('temperature').value));
  if (idToken && tokenExp * 1000 > Date.now() + 60_000) showBench();
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

  // workbench controls
  const sel = $('scenario');
  sel.replaceChildren();
  for (const s of info.scenarios) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = 'Custom prompt…';
  sel.appendChild(custom);
  onScenarioChange();

  const pick = $('model-pick');
  pick.replaceChildren();
  for (const m of info.models) {
    const label = document.createElement('label');
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
    showBench();
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
  $('bench-panel').hidden = true;
  $('login-panel').hidden = false;
}

function showBench() {
  $('login-panel').hidden = true;
  $('bench-panel').hidden = false;
  refreshQuota();
  refreshLedger();
}

async function api(method, path, body) {
  if (!idToken || tokenExp * 1000 < Date.now()) {
    logout();
    throw new Error('Session expired — please sign in again');
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
    throw new Error('Session expired — please sign in again');
  }
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
    const res = await api('POST', '/api/run', {
      ...(scenarioId ? { scenarioId } : { prompt }),
      models,
      temperature: Number($('temperature').value),
      maxTokens: Number($('max-tokens').value),
    });
    renderResults(res);
    renderQuota(res.quota);
    refreshLedger();
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

function renderResults(res) {
  const grid = $('results');
  grid.replaceChildren();
  for (const r of res.results) {
    const card = document.createElement('div');
    card.className = `res-card${r.ok ? '' : ' err'}`;

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
      if (r.stopReason && r.stopReason !== 'end_turn') metrics.append(pill(r.stopReason, 'warn'));
    } else {
      metrics.append(pill(r.error ?? 'failed', 'bad'));
    }

    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.textContent = r.ok ? r.text : 'The invocation failed — see the error badge above.';

    card.append(head, metrics, answer);
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
  }
}

// ---- quota + ledger --------------------------------------------------------

async function refreshQuota() {
  try {
    renderQuota(await api('GET', '/api/me/quota'));
  } catch {
    /* non-fatal */
  }
}

function renderQuota(q) {
  $('quota-line').textContent =
    `Your runs today: ${q.userUsed}/${q.userLimit} · demo-wide budget: ${q.globalUsed}/${q.globalLimit} · each run invokes every selected model once`;
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
      li.textContent = `${m?.label ?? r.key}: ${r.inputTokens}→${r.outputTokens} tok, $${(r.costUsd ?? 0).toFixed(5)}, ${(r.latencyMs / 1000).toFixed(1)}s (${r.stopReason ?? '–'})`;
      ul.appendChild(li);
    }
    const meta = document.createElement('p');
    meta.className = 'muted small';
    meta.style.marginTop = '6px';
    meta.textContent = `temperature ${run.temperature} · maxTokens ${run.maxTokens} · prompt: "${run.promptPreview}…"`;
    det.append(ul, meta);
    list.appendChild(det);
  }
}
