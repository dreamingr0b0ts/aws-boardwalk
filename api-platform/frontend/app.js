// Docs page for the Alpenglow Developer API. Everything renders from
// /openapi.json (the same spec Terraform imports into API Gateway) plus
// /config.json ({ demoKey }, written at publish time, never committed).
// No frameworks, no CDNs: the page only talks to its own origin.

const state = { demoKey: null, spec: null };

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    el.append(child.nodeType ? child : document.createTextNode(child));
  }
  return el;
}

// ---- data loading -----------------------------------------------------------

async function init() {
  const [config, spec] = await Promise.all([
    fetch('/config.json').then((r) => r.json()).catch(() => ({})),
    fetch('/openapi.json').then((r) => r.json()),
  ]);
  state.demoKey = config.demoKey ?? null;
  state.spec = spec;

  $('#demo-key').textContent = state.demoKey ?? 'unavailable';
  $('#quickstart').textContent = [
    '# no key needed for platform status',
    `curl ${origin()}/v2/status`,
    '',
    '# everything else: present your key',
    `curl -H "x-api-key: ${state.demoKey ?? 'YOUR_KEY'}" \\`,
    `  "${origin()}/v2/permits?status=issued&limit=5"`,
  ].join('\n');

  renderReference();
  loadStatus();
  loadUsage();
}

function origin() {
  return window.location.origin;
}

async function loadUsage() {
  try {
    const res = await fetch('/v2/platform/usage');
    const { data } = await res.json();
    const meter = $('#usage-meter');
    const pct = Math.min(100, Math.round((data.partyLine.used / data.partyLine.quota) * 100));
    $('#meter-used').textContent = `${data.partyLine.used.toLocaleString()} / ${data.partyLine.quota.toLocaleString()} calls`;
    $('#meter-fill').style.width = `${Math.max(pct, data.partyLine.used > 0 ? 2 : 0)}%`;
    $('#meter-note').textContent = `Read live from the demo key's usage plan · ${data.privateLines.issuedToday} of ${data.privateLines.dailyCap} personal lines installed today · resets midnight UTC.`;
    meter.hidden = false;
  } catch { /* the meter is garnish; the page works without it */ }
}

async function loadStatus() {
  try {
    const res = await fetch('/v2/status');
    const body = await res.json();
    $('#stat-status').textContent = body.status ?? '?';
    for (const svc of body.services ?? []) {
      const el = $(`#stat-${svc.name}`);
      if (el) el.textContent = (svc.approximateRecords ?? 0).toLocaleString();
    }
  } catch {
    $('#stat-status').textContent = 'unreachable';
  }
}

// ---- shared request runner ----------------------------------------------------

const INTERESTING_HEADERS = ['deprecation', 'sunset', 'link', 'location', 'etag', 'idempotency-replayed', 'x-amzn-requestid', 'x-amzn-errortype'];

async function runRequest({ method, path, headers = {}, body }) {
  const started = performance.now();
  const res = await fetch(path, { method, headers, body });
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  const shown = INTERESTING_HEADERS.map((name) => (res.headers.get(name) ? `${name}: ${res.headers.get(name)}` : null)).filter(Boolean);
  return { status: res.status, ms, headers: shown, text };
}

function exchangePane(reqLine, result) {
  let pretty = result.text;
  try { pretty = JSON.stringify(JSON.parse(result.text), null, 2); } catch { /* leave as-is */ }
  const cls = result.status < 300 || result.status === 304 ? 'good' : result.status === 429 ? 'warn' : 'bad';
  return h('div', { class: 'exchange' },
    h('div', { class: 'req' }, reqLine),
    h('div', { class: 'res' },
      h('div', { class: `status-line ${cls}` }, `HTTP ${result.status} · ${result.ms}ms`),
      result.headers.length ? h('div', { class: 'res-headers' }, result.headers.join('\n')) : null,
      h('pre', {}, pretty),
    ),
  );
}

// ---- guided demos -------------------------------------------------------------

const DEMOS = {
  async nokey() {
    const result = await runRequest({ method: 'GET', path: '/v2/permits?limit=3' });
    return [
      exchangePane(`GET /v2/permits?limit=3\n(no x-api-key header)`, result),
      h('p', { class: 'muted' }, 'API Gateway rejected this before any Lambda ran. The permits service never saw the request: the operator refused the call at the board.'),
    ];
  },

  async badbody() {
    const body = JSON.stringify({ type: 'quantum-vibe-check', preferredDate: 'soon' }, null, 2);
    const result = await runRequest({
      method: 'POST',
      path: '/v2/permits/PRM-2025-0104/inspections',
      headers: { 'x-api-key': state.demoKey, 'content-type': 'application/json' },
      body,
    });
    return [
      exchangePane(`POST /v2/permits/PRM-2025-0104/inspections\nx-api-key: ${short(state.demoKey)}\n\n${body}`, result),
      h('p', { class: 'muted' }, 'The gateway checked the body against the InspectionRequest JSON-schema model (bad enum value, malformed date, missing contactEmail) and answered itself. Application code never ran.'),
    ];
  },

  async deprecated() {
    const result = await runRequest({
      method: 'GET',
      path: '/v1/permits?limit=2',
      headers: { 'x-api-key': state.demoKey },
    });
    return [
      exchangePane(`GET /v1/permits?limit=2\nx-api-key: ${short(state.demoKey)}`, result),
      h('p', { class: 'muted' }, 'v1 still answers (integrations keep working) but every response carries Deprecation and Sunset headers plus a Link to its v2 successor. Deprecation as a contract, not a surprise.'),
    ];
  },

  async burst() {
    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        fetch('/v2/facilities?limit=1', { headers: { 'x-api-key': state.demoKey } })
          .then((r) => r.status)
          .catch(() => 0)
      )
    );
    const ok = results.filter((s) => s === 200).length;
    const throttled = results.filter((s) => s === 429).length;
    const other = N - ok - throttled;
    const dots = h('div', { class: 'burst-dots' },
      results.map((s) => h('span', {
        class: s === 200 ? 'd-ok' : s === 429 ? 'd-429' : 'd-err',
        title: `HTTP ${s}`,
      }, s === 200 ? '✓' : '!'))
    );
    return [
      h('div', { class: 'exchange' },
        h('div', { class: 'req' }, `${N} × GET /v2/facilities?limit=1  (parallel, demo key)`),
        h('div', { class: 'res' },
          h('div', { class: `status-line ${throttled ? 'warn' : 'good'}` },
            `${ok} × 200 · ${throttled} × 429 throttled${other ? ` · ${other} × other` : ''}`),
          dots,
        ),
      ),
      h('p', { class: 'muted' }, throttled
        ? 'The demo usage plan (2 req/s, burst 5) absorbed what it could and throttled the rest at the gateway. A partner-tier key gets 25 req/s and 50 burst against the identical API.'
        : 'All 30 slipped inside the burst window this time. Run it again and the token bucket will start pushing back.'),
    ];
  },

  async idem() {
    const page = await fetch('/v2/permits?status=issued&limit=1', { headers: { 'x-api-key': state.demoKey } }).then((r) => r.json());
    const id = page.data?.[0]?.id ?? 'PRM-2025-0104';
    const idemKey = `docs-${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({ type: 'final', preferredDate: '2026-08-21', contactEmail: 'retry@example.com', notes: 'idempotency demo' }, null, 2);
    const send = () => runRequest({
      method: 'POST',
      path: `/v2/permits/${id}/inspections`,
      headers: { 'x-api-key': state.demoKey, 'content-type': 'application/json', 'idempotency-key': idemKey },
      body,
    });
    const first = await send();
    const second = await send();
    return [
      exchangePane(`POST /v2/permits/${id}/inspections\nIdempotency-Key: ${idemKey}\n\n${body}`, first),
      exchangePane(`POST /v2/permits/${id}/inspections\nIdempotency-Key: ${idemKey}\n(the exact same request, sent again)`, second),
      h('p', { class: 'muted' }, 'Same key, same 201, same inspection id: the second response is the stored original, replayed — note the Idempotency-Replayed header. A client can retry a timed-out POST without double-booking the inspector.'),
    ];
  },

  async etag() {
    const first = await runRequest({ method: 'GET', path: '/v2/facilities/FAC-009', headers: { 'x-api-key': state.demoKey } });
    const tag = first.headers.find((line) => line.startsWith('etag:'))?.slice(5).trim();
    const second = await runRequest({
      method: 'GET',
      path: '/v2/facilities/FAC-009',
      headers: { 'x-api-key': state.demoKey, 'if-none-match': tag ?? '"none"' },
    });
    return [
      exchangePane('GET /v2/facilities/FAC-009', first),
      exchangePane(`GET /v2/facilities/FAC-009\nIf-None-Match: ${tag}`, second),
      h('p', { class: 'muted' }, 'The record has not changed, so the second answer is a bodiless 304 — cheaper for the caller, the network, and the server. A polling client gets its freshness check nearly for free.'),
    ];
  },
};

for (const btn of document.querySelectorAll('.demo-btn')) {
  btn.addEventListener('click', async () => {
    const out = $('#demo-out');
    out.hidden = false;
    out.replaceChildren(h('p', { class: 'muted' }, 'calling the live gateway…'));
    btn.disabled = true;
    try {
      out.replaceChildren(...(await DEMOS[btn.dataset.demo]()));
    } catch (err) {
      out.replaceChildren(h('p', { class: 'muted' }, `request failed: ${err}`));
    } finally {
      btn.disabled = false;
    }
  });
}

$('#copy-key').addEventListener('click', async () => {
  if (!state.demoKey) return;
  await navigator.clipboard.writeText(state.demoKey);
  $('#copy-key').textContent = 'Copied ✓';
  setTimeout(() => { $('#copy-key').textContent = 'Copy'; }, 1500);
});

function short(key) {
  return key ? `${key.slice(0, 8)}…` : 'YOUR_KEY';
}

// ---- your own line: self-service keys ----------------------------------------

$('#mint-btn').addEventListener('click', async () => {
  const btn = $('#mint-btn');
  const out = $('#mint-out');
  const label = $('#mint-label').value.trim();
  out.hidden = false;
  out.replaceChildren(h('p', { class: 'muted' }, 'asking the exchange for a line…'));
  btn.disabled = true;
  try {
    const body = JSON.stringify({ label });
    const result = await runRequest({ method: 'POST', path: '/v2/platform/keys', headers: { 'content-type': 'application/json' }, body });
    if (result.status !== 201) {
      // The gateway 400 (bad label) and the 429 caps are exhibits themselves.
      out.replaceChildren(exchangePane(`POST /v2/platform/keys\n\n${body}`, result));
      return;
    }
    const issued = JSON.parse(result.text).data;
    const copyBtn = h('button', { class: 'ghost', type: 'button' }, 'Copy');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(issued.apiKey);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
    const useBtn = h('button', { class: 'ghost', type: 'button' }, 'Use it on this page');
    useBtn.addEventListener('click', () => {
      state.demoKey = issued.apiKey;
      useBtn.textContent = 'In use on every try-it console ✓';
      useBtn.disabled = true;
    });
    const lineStatus = h('p', { class: 'muted' }, 'patching your line in… a brand-new key takes a minute or two to reach the gateway’s key cache.');
    out.replaceChildren(
      h('div', { class: 'keybox' },
        h('span', { class: 'keylabel' }, `your line · ${issued.label}`),
        h('code', {}, issued.apiKey),
        copyBtn,
        useBtn,
      ),
      h('p', { class: 'muted' }, `A real key on the ${issued.plan} plan — 2 req/s, ${issued.limits.quotaPerDay} requests/day of your own. Shown once, never retrievable, swept after ${new Date(issued.expiresAt).toUTCString()}.`),
      lineStatus,
    );
    loadUsage();
    // Watch the key go live against the real gateway — propagation as exhibit.
    // Detached on purpose: the button frees up while the line patches in.
    (async () => {
      for (let i = 1; i <= 36; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 5000); });
        try {
          const probe = await fetch('/v2/facilities?limit=1', { headers: { 'x-api-key': issued.apiKey } });
          if (probe.status === 200) {
            lineStatus.textContent = `line connected — the live gateway accepted your key after ${i * 5}s.`;
            return;
          }
          lineStatus.textContent = `patching your line in… ${i * 5}s (the gateway still answers 403 while its key cache updates)`;
        } catch { /* transient network hiccup; keep polling */ }
      }
      lineStatus.textContent = 'not accepted after 3 minutes — give it a moment and try the key manually.';
    })();
  } catch (err) {
    out.replaceChildren(h('p', { class: 'muted' }, `request failed: ${err}`));
  } finally {
    btn.disabled = false;
  }
});

// ---- order an export: the async-job pattern, live ----------------------------

$('#exp-btn').addEventListener('click', async () => {
  const btn = $('#exp-btn');
  const out = $('#exp-out');
  const service = $('#exp-service').value;
  const format = $('#exp-format').value;
  out.hidden = false;
  btn.disabled = true;
  const body = JSON.stringify({ service, format });
  try {
    const accepted = await runRequest({
      method: 'POST',
      path: '/v2/exports',
      headers: { 'x-api-key': state.demoKey, 'content-type': 'application/json' },
      body,
    });
    out.replaceChildren(exchangePane(`POST /v2/exports\nx-api-key: ${short(state.demoKey)}\n\n${body}`, accepted));
    if (accepted.status !== 202) return;
    const location = accepted.headers.find((l) => l.startsWith('location:'))?.slice(9).trim();
    const pollNote = h('p', { class: 'muted' }, `202 Accepted — polling ${location}…`);
    out.append(pollNote);
    for (let i = 1; i <= 20; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, i === 1 ? 600 : 1200); });
      const poll = await runRequest({ method: 'GET', path: location, headers: { 'x-api-key': state.demoKey } });
      let job = {};
      try { job = JSON.parse(poll.text).data ?? {}; } catch { /* non-JSON error body */ }
      pollNote.textContent = `poll ${i} → status: ${job.status ?? `HTTP ${poll.status}`}`;
      if (job.status === 'done' || job.status === 'failed' || poll.status !== 200) {
        out.append(exchangePane(`GET ${location}\nx-api-key: ${short(state.demoKey)}   (poll ${i})`, poll));
        if (job.status === 'done') {
          out.append(h('p', {},
            h('a', { href: job.downloadUrl }, `Download alpenglow-${service}-export.${format} (${job.count} records)`),
            h('span', { class: 'muted' }, ' — presigned URL, valid 15 minutes; the bucket itself is never public.'),
          ));
        }
        return;
      }
    }
    pollNote.textContent = `still running after 20 polls — the job record remains at ${location}`;
  } catch (err) {
    out.append(h('p', { class: 'muted' }, `request failed: ${err}`));
  } finally {
    btn.disabled = false;
  }
});

// ---- API reference ------------------------------------------------------------

function resolveRef(node) {
  if (node && node.$ref) {
    const parts = node.$ref.replace('#/', '').split('/');
    let target = state.spec;
    for (const part of parts) target = target?.[part];
    return target ?? node;
  }
  return node;
}

function schemaLabel(schema) {
  const s = resolveRef(schema ?? {});
  if (s.enum) return s.enum.join(' | ');
  if (s.type === 'array') return `array<${schemaLabel(s.items)}>`;
  return s.type ?? 'object';
}

function exampleBody(schema) {
  const s = resolveRef(schema);
  const sample = {};
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    const p = resolveRef(prop);
    if (p.enum) sample[name] = p.enum[0];
    else if (name === 'preferredDate') sample[name] = '2026-08-14';
    else if (name.toLowerCase().includes('email')) sample[name] = 'you@example.com';
    else if (p.type === 'integer') sample[name] = 1;
    else if ((s.required ?? []).includes(name)) sample[name] = 'text';
  }
  return JSON.stringify(sample, null, 2);
}

function opNeedsKey(op) {
  return Boolean(op.security && op.security.length);
}

function paramsTable(op, schema) {
  const params = (op.parameters ?? []).filter((p) => p.in === 'query');
  const bodyProps = schema ? Object.entries(resolveRef(schema).properties ?? {}) : [];
  if (!params.length && !bodyProps.length) return null;
  const required = schema ? (resolveRef(schema).required ?? []) : [];
  return h('div', {},
    h('h5', {}, schema ? 'request body (gateway-validated)' : 'query parameters'),
    h('table', { class: 'params' },
      h('thead', {}, h('tr', {}, h('th', {}, 'name'), h('th', {}, 'type'), h('th', {}, 'notes'))),
      h('tbody', {},
        params.map((p) => h('tr', {},
          h('td', {}, h('code', {}, p.name)),
          h('td', {}, schemaLabel(p.schema)),
          h('td', {}, p.description ?? (p.required ? 'required' : 'optional')),
        )),
        bodyProps.map(([name, prop]) => h('tr', {},
          h('td', {}, h('code', {}, name)),
          h('td', {}, schemaLabel(prop)),
          h('td', {}, [
            required.includes(name) ? 'required' : 'optional',
            resolveRef(prop).description ? ` · ${resolveRef(prop).description}` : '',
            resolveRef(prop).pattern ? ` (pattern ${resolveRef(prop).pattern})` : '',
          ].join('')),
        )),
      ),
    ),
  );
}

function tryIt(method, pathTemplate, op) {
  const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path');
  const needsBody = method === 'post';
  const inputs = h('div', { class: 'inputs' });
  const fields = {};

  for (const p of pathParams) {
    const input = h('input', { value: p.example ?? '', spellcheck: 'false' });
    fields[p.name] = input;
    inputs.append(h('label', {}, `{${p.name}}`, input));
  }
  const queryInput = h('input', { placeholder: 'limit=5&status=issued', spellcheck: 'false' });
  if ((op.parameters ?? []).some((p) => p.in === 'query')) {
    inputs.append(h('label', {}, 'query string', queryInput));
  }
  let bodyInput = null;
  if (needsBody) {
    const schema = op.requestBody?.content?.['application/json']?.schema;
    bodyInput = h('textarea', { rows: '6', spellcheck: 'false' }, schema ? exampleBody(schema) : '{}');
  }

  const out = h('div', {});
  const send = h('button', { class: 'send', type: 'button' }, 'Send request');
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      let path = pathTemplate;
      for (const [name, input] of Object.entries(fields)) {
        path = path.replace(`{${name}}`, encodeURIComponent(input.value.trim()));
      }
      const query = queryInput.value.trim();
      if (query) path += `?${query}`;
      const headers = {};
      const reqLines = [`${method.toUpperCase()} ${path}`];
      if (opNeedsKey(op)) {
        headers['x-api-key'] = state.demoKey;
        reqLines.push(`x-api-key: ${short(state.demoKey)}`);
      }
      let body;
      if (bodyInput) {
        headers['content-type'] = 'application/json';
        body = bodyInput.value;
        reqLines.push('', body);
      }
      const result = await runRequest({ method: method.toUpperCase(), path, headers, body });
      out.replaceChildren(exchangePane(reqLines.join('\n'), result));
    } catch (err) {
      out.replaceChildren(h('p', { class: 'muted' }, `request failed: ${err}`));
    } finally {
      send.disabled = false;
    }
  });

  return h('div', { class: 'tryit' },
    h('h5', {}, 'try it (live)'),
    inputs,
    bodyInput,
    send,
    out,
  );
}

function curlFor(method, path, op) {
  const example = path.replace(/\{(\w+)\}/g, (_, name) => {
    const p = (op.parameters ?? []).find((x) => x.name === name && x.in === 'path');
    return p?.example ?? `{${name}}`;
  });
  const parts = [method === 'get' ? 'curl' : `curl -X ${method.toUpperCase()}`];
  if (opNeedsKey(op)) parts.push(`-H "x-api-key: ${state.demoKey ?? 'YOUR_KEY'}"`);
  if (method === 'post') {
    const schema = op.requestBody?.content?.['application/json']?.schema;
    parts.push('-H "content-type: application/json"');
    parts.push(`-d '${schema ? exampleBody(schema).replace(/\n\s*/g, ' ') : '{}'}'`);
  }
  parts.push(`"${origin()}${example}"`);
  return parts.join(' \\\n  ');
}

function renderReference() {
  const container = $('#reference');
  container.replaceChildren();
  const tags = state.spec.tags ?? [];
  const byTag = new Map(tags.map((t) => [t.name, []]));

  for (const [path, methods] of Object.entries(state.spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags?.[0] ?? 'other';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method, op });
    }
  }

  for (const tag of tags) {
    const ops = byTag.get(tag.name) ?? [];
    if (!ops.length) continue;
    const section = h('div', { class: 'svc' },
      h('h3', {}, `${tag.name} service`),
      tag.description ? h('p', {}, tag.description) : null,
    );
    for (const { path, method, op } of ops) {
      const schema = method === 'post' ? op.requestBody?.content?.['application/json']?.schema : null;
      section.append(
        h('details', { class: 'op' },
          h('summary', {},
            h('span', { class: `method ${method}` }, method.toUpperCase()),
            h('span', { class: 'op-path' }, path),
            op.deprecated ? h('span', { class: 'badge dep' }, 'deprecated') : null,
            !opNeedsKey(op) ? h('span', { class: 'badge open' }, 'no key') : null,
            h('span', { class: 'op-sum' }, op.summary ?? ''),
          ),
          h('div', { class: 'op-body' },
            op.description ? h('p', { class: 'op-desc' }, op.description) : null,
            paramsTable(op, null),
            schema ? paramsTable(op, schema) : null,
            h('pre', { class: 'code' }, curlFor(method, path, op)),
            tryIt(method, path, op),
          ),
        ),
      );
    }
    container.append(section);
  }
}

init().catch((err) => {
  $('#reference').replaceChildren(h('p', { class: 'muted' }, `failed to load the API spec: ${err}`));
});
