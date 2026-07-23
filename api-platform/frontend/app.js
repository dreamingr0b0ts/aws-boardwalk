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
}

function origin() {
  return window.location.origin;
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

const INTERESTING_HEADERS = ['deprecation', 'sunset', 'link', 'location', 'x-amzn-requestid', 'x-amzn-errortype'];

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
  const cls = result.status < 300 ? 'good' : result.status === 429 ? 'warn' : 'bad';
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
