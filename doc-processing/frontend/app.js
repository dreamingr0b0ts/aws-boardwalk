// Alpenglow Document Intelligence — zero-build frontend.
// Browsing the processed index is public (free DynamoDB reads). Uploading —
// the only operation that spends money — sits behind a Cognito gate; auth is
// a plain InitiateAuth call, and the file itself goes straight to S3 with a
// presigned POST. Everything else is same-origin /api/* behind CloudFront.

const $ = (id) => document.getElementById(id);

const DOC_TYPE_LABELS = {
  'permit-application': 'Permit application',
  'inspection-report': 'Inspection report',
  'license-certificate': 'License / certificate',
  invoice: 'Invoice',
  'violation-notice': 'Violation notice',
  'meeting-minutes': 'Meeting minutes',
  correspondence: 'Correspondence',
  other: 'Other',
};

const PIPELINE_STEPS = ['received', 'ocr-started', 'ocr-complete', 'entities-complete', 'classified', 'indexed'];

let config = null; // { region, userPoolClientId } written at publish time
let idToken = sessionStorage.getItem('idp.idToken') || null;
let tokenExp = Number(sessionStorage.getItem('idp.exp') || 0);

let allDocs = [];
let activeType = null; // facet filter
let searchTerm = '';

init();

async function init() {
  config = await (await fetch('/config.json')).json();

  $('login-form').addEventListener('submit', onLogin);
  $('logout-btn').addEventListener('click', logout);
  $('search').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderGrid();
  });
  $('file-input').addEventListener('change', () => {
    if ($('file-input').files[0]) onUpload($('file-input').files[0]);
  });
  const zone = $('dropzone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer.files[0]) onUpload(e.dataTransfer.files[0]);
  });
  $('dialog-close').addEventListener('click', () => $('doc-dialog').close());
  $('doc-dialog').addEventListener('click', (e) => {
    if (e.target === $('doc-dialog')) $('doc-dialog').close();
  });

  if (idToken && tokenExp * 1000 > Date.now() + 60_000) showUploader();
  await loadIndex();
}

// ---- public index -----------------------------------------------------------

async function loadIndex() {
  try {
    const res = await (await fetch('/api/public/documents')).json();
    allDocs = res.documents ?? [];
    $('stat-docs').textContent = res.stats.documents;
    $('stat-pages').textContent = res.stats.pages;
    $('stat-entities').textContent = res.stats.entities;
    $('stat-types').textContent = res.stats.docTypes;
    renderFacets();
    renderGrid();
  } catch {
    $('doc-grid').innerHTML = '<p class="muted">Could not load the index — try refreshing.</p>';
  }
}

function renderFacets() {
  const counts = new Map();
  for (const d of allDocs) {
    if (d.status !== 'INDEXED' || !d.docType) continue;
    counts.set(d.docType, (counts.get(d.docType) ?? 0) + 1);
  }
  const el = $('facets');
  el.innerHTML = '';
  const mkChip = (label, value, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'facet' + ((value === activeType) ? ' on' : '');
    b.innerHTML = `${label} ${count === null ? '' : `<span class="n">${count}</span>`}`;
    b.addEventListener('click', () => {
      activeType = activeType === value ? null : value;
      renderFacets();
      renderGrid();
    });
    el.appendChild(b);
  };
  mkChip('All types', null, null);
  for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    mkChip(DOC_TYPE_LABELS[type] ?? type, type, n);
  }
}

function matches(d) {
  if (activeType && d.docType !== activeType) return false;
  if (!searchTerm) return true;
  const hay = [d.title, d.summary, d.filename, d.docType].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(searchTerm);
}

function renderGrid() {
  const grid = $('doc-grid');
  grid.innerHTML = '';
  const docs = allDocs.filter(matches);
  if (!docs.length) {
    grid.innerHTML = '<p class="muted">No documents match — clear the search or facet filters.</p>';
    return;
  }
  for (const d of docs) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'doc-card' + (d.status === 'INDEXED' ? '' : ' pending');
    const badges = [];
    if (d.docType) badges.push(`<span class="badge type">${esc(DOC_TYPE_LABELS[d.docType] ?? d.docType)}</span>`);
    if (d.status !== 'INDEXED') badges.push(`<span class="badge status-${esc(d.status)}">${esc(d.status)}</span>`);
    if (d.hasPii) badges.push('<span class="badge pii">PII</span>');
    const meta = [
      d.pages ? `${d.pages} page${d.pages > 1 ? 's' : ''}` : null,
      d.ocrConfidence ? `OCR ${d.ocrConfidence}%` : null,
      d.entityCount ? `${d.entityCount} entities` : null,
      d.source === 'upload' ? 'uploaded' : 'seed corpus',
    ].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div>${badges.join(' ')}</div>
      <h3>${esc(d.title ?? d.filename)}</h3>
      <p class="sum">${esc(d.summary ?? (d.rejectReason ? `Rejected: ${d.rejectReason}` : 'Processing…'))}</p>
      <p class="meta">${esc(meta)}</p>`;
    card.addEventListener('click', () => openDoc(d.docId));
    grid.appendChild(card);
  }
}

async function openDoc(docId) {
  let d;
  try {
    const res = await fetch(`/api/public/documents/${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error();
    d = await res.json();
  } catch {
    return;
  }

  $('d-title').textContent = d.title ?? d.filename;
  const badges = $('d-badges');
  badges.innerHTML = '';
  if (d.docType) {
    const t = document.createElement('span');
    t.className = 'badge type';
    t.textContent = `${DOC_TYPE_LABELS[d.docType] ?? d.docType} · ${(Math.round((d.docTypeConfidence ?? 0) * 100))}% confident`;
    badges.appendChild(t);
  }
  const s = document.createElement('span');
  s.className = `badge status-${d.status}`;
  s.textContent = d.status;
  badges.appendChild(s);
  if (d.hasPii) {
    const p = document.createElement('span');
    p.className = 'badge pii';
    p.textContent = `PII: ${(d.piiLabels ?? []).join(', ').toLowerCase() || 'detected'}`;
    badges.appendChild(p);
  }

  $('d-summary').textContent = d.summary ?? d.rejectReason ?? d.error ?? '';
  $('d-meta').innerHTML = [
    d.docDate ? `<span>document date <strong>${esc(d.docDate)}</strong></span>` : null,
    d.pages ? `<span><strong>${d.pages}</strong> page${d.pages > 1 ? 's' : ''}</span>` : null,
    d.ocrConfidence ? `<span>OCR confidence <strong>${d.ocrConfidence}%</strong></span>` : null,
    `<span>file <strong>${esc(d.filename)}</strong> (${(d.sizeBytes / 1024).toFixed(0)} KB)</span>`,
    `<span>source <strong>${d.source === 'upload' ? 'demo upload' : 'seed corpus'}</strong></span>`,
  ].filter(Boolean).join('');

  const kv = $('d-kv');
  kv.innerHTML = (d.kvPairs ?? []).map((p) =>
    `<tr><td>${esc(p.key)}</td><td>${esc(p.value || '—')} <span class="conf">${p.confidence}%</span></td></tr>`
  ).join('') || '<tr><td class="muted">none detected</td><td></td></tr>';

  const ents = $('d-entities');
  ents.innerHTML = (d.entities ?? []).map((e) =>
    `<span class="ent">${esc(e.text)} <span class="et">${esc(e.type)}</span></span>`
  ).join('') || '<span class="muted">none detected</span>';

  const steps = $('d-steps');
  const t0 = d.steps?.[0] ? new Date(d.steps[0].at).getTime() : 0;
  steps.innerHTML = (d.steps ?? []).map((st) =>
    `<li>${esc(st.name)} <span class="t">+${((new Date(st.at).getTime() - t0) / 1000).toFixed(1)}s</span></li>`
  ).join('');

  $('d-original').href = d.originalUrl;
  $('d-preview').textContent = d.textPreview ?? '';
  $('d-preview-label').hidden = !d.textPreview;
  $('doc-dialog').showModal();
}

// ---- auth ---------------------------------------------------------------

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
    if (!res.ok || !data.AuthenticationResult) {
      throw new Error(data.message || 'Sign-in failed');
    }
    idToken = data.AuthenticationResult.IdToken;
    tokenExp = JSON.parse(atob(idToken.split('.')[1])).exp;
    sessionStorage.setItem('idp.idToken', idToken);
    sessionStorage.setItem('idp.exp', String(tokenExp));
    $('login-password').value = '';
    showUploader();
  } catch (err) {
    const el = $('login-error');
    el.textContent = err.message === 'Incorrect username or password.'
      ? 'Incorrect email or password.'
      : `Could not sign in: ${err.message}`;
    el.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function logout() {
  sessionStorage.removeItem('idp.idToken');
  sessionStorage.removeItem('idp.exp');
  idToken = null;
  $('upload-panel').hidden = true;
  $('login-panel').hidden = false;
}

function showUploader() {
  $('login-panel').hidden = true;
  $('upload-panel').hidden = false;
  refreshQuota();
}

async function refreshQuota() {
  try {
    renderQuota(await api('GET', '/api/me/quota'));
  } catch { /* non-fatal */ }
}

function renderQuota(q) {
  $('quota-line').textContent =
    `Your documents today: ${q.userUsed}/${q.userLimit} · demo-wide budget: ${q.globalUsed}/${q.globalLimit}`;
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

// ---- upload & live pipeline tracking -----------------------------------

const EXT_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff',
};

async function onUpload(file) {
  const zone = $('dropzone');
  const errEl = $('upload-error');
  errEl.hidden = true;
  $('pipeline-result').hidden = true;

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = EXT_TYPES[ext];
  if (!contentType) {
    return showUploadError('That file type is not supported — PDF, PNG, JPEG, or TIFF only.');
  }
  if (file.size > 4 * 1024 * 1024) {
    return showUploadError('That file is over the 4 MB demo cap.');
  }

  zone.classList.add('busy');
  try {
    const grant = await api('POST', '/api/uploads', {
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    });
    renderQuota(grant.quota);

    const form = new FormData();
    for (const [k, v] of Object.entries(grant.upload.fields)) form.append(k, v);
    form.append('file', file);
    const s3res = await fetch(grant.upload.url, { method: 'POST', body: form });
    if (!s3res.ok) throw new Error(`S3 rejected the upload (${s3res.status})`);

    trackPipeline(grant.docId);
  } catch (err) {
    showUploadError(err.message);
  } finally {
    zone.classList.remove('busy');
    $('file-input').value = '';
  }
}

function showUploadError(message) {
  const el = $('upload-error');
  el.textContent = `⚠ ${message}`;
  el.hidden = false;
}

async function trackPipeline(docId) {
  const tracker = $('pipeline-tracker');
  const result = $('pipeline-result');
  tracker.hidden = false;
  updateTracker([]);

  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    let doc;
    try {
      const res = await fetch(`/api/public/documents/${encodeURIComponent(docId)}`);
      if (!res.ok) continue; // record may not exist for a second or two
      doc = await res.json();
    } catch {
      continue;
    }

    updateTracker(doc.steps ?? []);

    if (doc.status === 'INDEXED') {
      result.textContent = '✓ Indexed — it is now in the searchable list above.';
      result.hidden = false;
      await loadIndex();
      openDoc(docId);
      return;
    }
    if (doc.status === 'REJECTED') {
      result.textContent = `✗ Rejected before OCR: ${doc.rejectReason}`;
      result.hidden = false;
      await loadIndex();
      return;
    }
    if (doc.status === 'FAILED') {
      result.textContent = '✗ The pipeline failed on this document — see its record for details.';
      result.hidden = false;
      await loadIndex();
      return;
    }
  }
  result.textContent = 'Still processing — it will appear in the index when done.';
  result.hidden = false;
}

function updateTracker(steps) {
  const done = new Set(steps.map((s) => s.name));
  const byName = Object.fromEntries(steps.map((s) => [s.name, s]));
  const t0 = steps[0] ? new Date(steps[0].at).getTime() : 0;
  let lastDoneIdx = -1;
  PIPELINE_STEPS.forEach((name, i) => { if (done.has(name)) lastDoneIdx = i; });

  [...$('pipeline-tracker').children].forEach((li, i) => {
    const name = li.dataset.step;
    li.className = done.has(name) ? 'done' : (i === lastDoneIdx + 1 ? 'active' : '');
    li.querySelector('.t').textContent = byName[name]
      ? `+${((new Date(byName[name].at).getTime() - t0) / 1000).toFixed(1)}s`
      : '';
  });
}

// ---- utils ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
