// Alpenglow Document Intelligence — zero-build frontend.
// Browsing the processed index is public (free DynamoDB reads). Uploading
// comes in two tiers: an anonymous taste tier (5 documents/day per visitor,
// private to the uploader, fenced server-side by hashed IP) and a Cognito
// gate for the credentialed allowance. Files go straight to S3 with a
// presigned POST; everything else is same-origin /api/* behind CloudFront.
// The document viewer renders the original in-page (pdf.js for PDFs, both
// self-hosted) and draws the pipeline's extraction geometry on top of it.

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

const signedIn = () => Boolean(idToken && tokenExp * 1000 > Date.now() + 60_000);

init();

async function init() {
  config = await (await fetch('/config.json')).json();

  $('login-form').addEventListener('submit', onLogin);
  $('logout-btn').addEventListener('click', logout);
  $('show-login-btn').addEventListener('click', () => {
    $('login-panel').hidden = !$('login-panel').hidden;
  });
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

  for (const btn of document.querySelectorAll('.v-mode')) {
    btn.addEventListener('click', () => setViewerMode(btn.dataset.mode));
  }
  $('v-prev').addEventListener('click', () => gotoPage(viewer.page - 1));
  $('v-next').addEventListener('click', () => gotoPage(viewer.page + 1));
  $('v-download').addEventListener('click', downloadRedactedPage);
  const kvTable = $('d-kv');
  kvTable.addEventListener('mouseover', (e) => hoverKvRow(e.target.closest('tr'), true));
  kvTable.addEventListener('mouseout', (e) => hoverKvRow(e.target.closest('tr'), false));
  kvTable.addEventListener('click', (e) => jumpToKvRow(e.target.closest('tr')));

  if (signedIn()) showSignedIn();
  else showAnon();
  renderMyDocs();
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
    $('doc-grid').innerHTML = '<p class="muted">Could not load the index. Try refreshing.</p>';
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
    grid.innerHTML = '<p class="muted">No documents match. Clear the search or facet filters.</p>';
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
      d.cost?.total ? `$${d.cost.total.toFixed(3)}` : null,
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
    if (!res.ok) {
      if (res.status === 404 && myDocs().some((m) => m.docId === docId)) {
        forgetMyDoc(docId);
        renderMyDocs();
      }
      throw new Error();
    }
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
  if (d.source === 'anon') {
    const a = document.createElement('span');
    a.className = 'badge';
    a.textContent = 'private · purges in 24h';
    badges.appendChild(a);
  }

  $('d-summary').textContent = d.summary ?? d.rejectReason ?? d.error ?? '';
  $('d-meta').innerHTML = [
    d.docDate ? `<span>document date <strong>${esc(d.docDate)}</strong></span>` : null,
    d.pages ? `<span><strong>${d.pages}</strong> page${d.pages > 1 ? 's' : ''}</span>` : null,
    d.ocrConfidence ? `<span>OCR confidence <strong>${d.ocrConfidence}%</strong></span>` : null,
    `<span>file <strong>${esc(d.filename)}</strong> (${(d.sizeBytes / 1024).toFixed(0)} KB)</span>`,
    `<span>source <strong>${d.source === 'seed' ? 'seed corpus' : d.source === 'anon' ? 'anonymous upload' : 'demo upload'}</strong></span>`,
  ].filter(Boolean).join('');

  const kv = $('d-kv');
  kv.innerHTML = (d.kvPairs ?? []).map((p, i) =>
    `<tr data-i="${i}" data-page="${p.valueBox?.p ?? p.keyBox?.p ?? ''}">
      <td>${esc(p.key)}</td><td>${esc(p.value || '—')} <span class="conf">${p.confidence}%</span></td></tr>`
  ).join('') || '<tr><td class="muted">none detected</td><td></td></tr>';
  $('d-kv-hint').hidden = !(d.kvPairs ?? []).some((p) => p.valueBox || p.keyBox);

  const ents = $('d-entities');
  ents.innerHTML = (d.entities ?? []).map((e) =>
    `<span class="ent">${esc(e.text)} <span class="et">${esc(e.type)}</span></span>`
  ).join('') || '<span class="muted">none detected</span>';

  const steps = $('d-steps');
  const t0 = d.steps?.[0] ? new Date(d.steps[0].at).getTime() : 0;
  steps.innerHTML = (d.steps ?? []).map((st) =>
    `<li>${esc(st.name)} <span class="t">+${((new Date(st.at).getTime() - t0) / 1000).toFixed(1)}s</span></li>`
  ).join('');

  renderReceipt(d);

  $('d-original').href = d.originalUrl;
  $('d-preview').textContent = d.textPreview ?? '';
  $('d-preview-label').hidden = !d.textPreview;
  $('doc-dialog').showModal();

  openViewer(d); // async; renders when the bytes and pdf.js arrive
}

// ---- the processing receipt ------------------------------------------------

function renderReceipt(d) {
  const el = $('d-receipt');
  if (!d.cost) {
    el.innerHTML = '<span class="muted">not itemized</span>';
    return;
  }
  const money = (n) => `$${(n ?? 0).toFixed(4)}`;
  const rows = [
    ['OCR · Textract FORMS', `${d.pages ?? '?'} page${d.pages === 1 ? '' : 's'}`, money(d.cost.textract)],
    ['NLP · Comprehend ×2', `${d.comprehendUnits ?? '?'} units`, money(d.cost.comprehend)],
    ['Classify · Claude Haiku', `${d.tokensIn ?? '?'} in / ${d.tokensOut ?? '?'} out`, money(d.cost.bedrock)],
  ];
  el.innerHTML =
    rows.map(([svc, qty, amt]) =>
      `<div class="r-line"><span>${esc(svc)}</span><span class="r-qty">${esc(qty)}</span><span class="r-amt">${amt}</span></div>`
    ).join('') +
    `<div class="r-line r-total"><span>total, this document</span><span class="r-qty"></span><span class="r-amt">${money(d.cost.total)}</span></div>`;
}

// ---- the viewer: source under glass ----------------------------------------

const viewer = {
  session: 0,     // bumped per openDoc; stale async renders bail out
  doc: null,
  pdf: null,
  bitmap: null,
  page: 1,
  pages: 1,
  mode: 'fields',
};

let pdfjsPromise = null;
function pdfjs() {
  pdfjsPromise ??= import('/vendor/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

function viewerNote(text) {
  $('v-note').textContent = text;
  $('v-note').hidden = !text;
}

async function openViewer(d) {
  const session = ++viewer.session;
  viewer.doc = d;
  viewer.pdf = null;
  viewer.bitmap = null;
  viewer.page = 1;
  $('d-viewer').hidden = true;
  viewerNote('');

  if (!d.originalUrl || d.status === 'REJECTED') return;
  if (d.contentType === 'image/tiff') return; // browsers cannot decode TIFF

  try {
    const res = await fetch(d.originalUrl);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buf = await res.arrayBuffer();
    if (session !== viewer.session) return;

    if (d.contentType === 'application/pdf') {
      const lib = await pdfjs();
      const pdf = await lib.getDocument({ data: buf }).promise;
      if (session !== viewer.session) { pdf.destroy(); return; }
      viewer.pdf = pdf;
      viewer.pages = pdf.numPages;
    } else {
      viewer.bitmap = await createImageBitmap(new Blob([buf], { type: d.contentType }));
      if (session !== viewer.session) return;
      viewer.pages = 1;
    }
  } catch {
    return; // the "view the original" link still works
  }

  const hasKvBoxes = (d.kvPairs ?? []).some((p) => p.valueBox || p.keyBox);
  const hasPiiBoxes = (d.piiEntities ?? []).some((p) => (p.boxes ?? []).length);
  viewer.mode = hasKvBoxes ? 'fields' : hasPiiBoxes ? 'redact' : 'none';
  $('v-mode-fields').disabled = !hasKvBoxes;
  $('v-mode-redact').disabled = !hasPiiBoxes;

  $('d-viewer').hidden = false;
  await renderViewerPage(session);
}

function setViewerMode(mode) {
  viewer.mode = mode;
  renderViewerPage(viewer.session);
}

function gotoPage(n) {
  if (n < 1 || n > viewer.pages) return;
  viewer.page = n;
  renderViewerPage(viewer.session);
}

async function renderViewerPage(session) {
  const canvas = $('page-canvas');

  if (viewer.pdf) {
    const page = await viewer.pdf.getPage(viewer.page);
    if (session !== viewer.session) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1400 / base.width);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (session !== viewer.session) return;
  } else if (viewer.bitmap) {
    const bm = viewer.bitmap;
    const scale = Math.min(1, 2000 / bm.width);
    canvas.width = Math.round(bm.width * scale);
    canvas.height = Math.round(bm.height * scale);
    canvas.getContext('2d').drawImage(bm, 0, 0, canvas.width, canvas.height);
  } else {
    return;
  }

  $('v-page-label').textContent = `page ${viewer.page} of ${viewer.pages}`;
  $('v-prev').disabled = viewer.page <= 1;
  $('v-next').disabled = viewer.page >= viewer.pages;

  for (const btn of document.querySelectorAll('.v-mode')) {
    btn.classList.toggle('on', btn.dataset.mode === viewer.mode);
  }

  renderOverlays();
}

function pctBox(box) {
  return `left:${box.l * 100}%;top:${box.t * 100}%;width:${box.w * 100}%;height:${box.h * 100}%`;
}

function pagePiiBoxes() {
  return (viewer.doc?.piiEntities ?? [])
    .flatMap((p) => (p.boxes ?? []).map((b) => ({ type: p.type, box: b })))
    .filter((x) => x.box.p === viewer.page);
}

function renderOverlays() {
  const layer = $('page-overlays');
  layer.innerHTML = '';
  const d = viewer.doc;

  if (viewer.mode === 'fields') {
    (d.kvPairs ?? []).forEach((p, i) => {
      for (const [cls, box] of [['ov-key', p.keyBox], ['ov-val', p.valueBox]]) {
        if (!box || box.p !== viewer.page) continue;
        const div = document.createElement('div');
        div.className = `ov ${cls}`;
        div.dataset.i = i;
        div.style.cssText = pctBox(box);
        div.title = `${p.key}: ${p.value || '(empty)'}`;
        layer.appendChild(div);
      }
    });
    viewerNote('Brass boxes are values, dashed boxes their labels, exactly where Textract read them.');
  } else if (viewer.mode === 'redact') {
    for (const { type, box } of pagePiiBoxes()) {
      const div = document.createElement('div');
      div.className = 'ov ov-redact';
      div.style.cssText = pctBox(box);
      div.innerHTML = `<span>${esc(type.replaceAll('_', ' '))}</span>`;
      layer.appendChild(div);
    }
    viewerNote('Every bar is a PII span Comprehend found, mapped back to the page. This is the pass a records office runs before releasing a copy.');
  } else {
    viewerNote('');
  }

  $('v-download').hidden = !(viewer.mode === 'redact' && pagePiiBoxes().length);
}

function hoverKvRow(row, on) {
  if (!row?.dataset.i) return;
  for (const ov of document.querySelectorAll(`.ov[data-i="${row.dataset.i}"]`)) {
    ov.classList.toggle('hot', on);
  }
}

function jumpToKvRow(row) {
  if (!row?.dataset.i || $('d-viewer').hidden) return;
  const p = Number(row.dataset.page);
  const flash = () => {
    hoverKvRow(row, true);
    $('page-stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => hoverKvRow(row, false), 1600);
  };
  if (viewer.mode !== 'fields') viewer.mode = 'fields';
  if (p && p !== viewer.page) {
    viewer.page = p;
    renderViewerPage(viewer.session).then(flash);
  } else {
    renderViewerPage(viewer.session).then(flash);
  }
}

function downloadRedactedPage() {
  const src = $('page-canvas');
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = '#14100b';
  for (const { box } of pagePiiBoxes()) {
    const pad = 2;
    ctx.fillRect(box.l * out.width - pad, box.t * out.height - pad, box.w * out.width + pad * 2, box.h * out.height + pad * 2);
  }
  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stem = (viewer.doc?.filename ?? 'document').replace(/\.[^.]+$/, '');
    a.download = `${stem}-redacted-p${viewer.page}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, 'image/png');
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
    $('login-panel').hidden = true;
    showSignedIn();
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
  showAnon();
}

function showSignedIn() {
  $('show-login-btn').hidden = true;
  $('logout-btn').hidden = false;
  $('dropzone-note').textContent =
    'PDF · PNG · JPEG · TIFF, up to 4 MB and 6 pages. Signed-in uploads join the public index until the nightly reset.';
  refreshQuota();
}

function showAnon() {
  $('show-login-btn').hidden = false;
  $('logout-btn').hidden = true;
  $('dropzone-note').textContent =
    'PDF · PNG · JPEG · TIFF, up to 4 MB and 6 pages. Anonymous uploads are private to you and purge within 24 hours.';
  refreshAnonQuota();
}

async function refreshQuota() {
  try {
    renderQuota(await api('GET', '/api/me/quota'));
  } catch { /* non-fatal */ }
}

async function refreshAnonQuota() {
  try {
    const res = await fetch('/api/public/uploads/quota');
    if (!res.ok) return;
    renderQuota(await res.json());
  } catch { /* non-fatal */ }
}

function renderQuota(q) {
  if (q.anonLimit !== undefined) {
    const left = Math.max(0, q.anonLimit - q.anonUsed);
    $('quota-line').textContent =
      `Anonymous documents today: ${left} of ${q.anonLimit} left · visitor pool ${q.poolUsed}/${q.poolLimit}` +
      (q.globalExhausted ? ' · daily budget exhausted' : '');
  } else {
    $('quota-line').textContent =
      `Your documents today: ${q.userUsed}/${q.userLimit} · demo-wide budget: ${q.globalUsed}/${q.globalLimit}`;
  }
}

async function api(method, path, body) {
  if (!idToken || tokenExp * 1000 < Date.now()) {
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

// ---- your anonymous documents (this browser only) --------------------------

function myDocs() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('idp.myDocs') || '[]'); } catch { /* fresh start */ }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const fresh = list.filter((m) => m.at > cutoff);
  if (fresh.length !== list.length) localStorage.setItem('idp.myDocs', JSON.stringify(fresh));
  return fresh;
}

function saveMyDoc(docId, filename) {
  const list = myDocs().filter((m) => m.docId !== docId);
  list.unshift({ docId, filename, at: Date.now() });
  localStorage.setItem('idp.myDocs', JSON.stringify(list.slice(0, 10)));
  renderMyDocs();
}

function forgetMyDoc(docId) {
  localStorage.setItem('idp.myDocs', JSON.stringify(myDocs().filter((m) => m.docId !== docId)));
}

function renderMyDocs() {
  const list = myDocs();
  $('my-docs').hidden = !list.length;
  const chips = $('my-doc-chips');
  chips.innerHTML = '';
  for (const m of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ent my-doc';
    b.innerHTML = `${esc(m.filename)} <span class="et">${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
    b.addEventListener('click', () => openDoc(m.docId));
    chips.appendChild(b);
  }
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
    return showUploadError('That file type is not supported: PDF, PNG, JPEG, or TIFF only.');
  }
  if (file.size > 4 * 1024 * 1024) {
    return showUploadError('That file is over the 4 MB demo cap.');
  }

  const anon = !signedIn();
  zone.classList.add('busy');
  try {
    const payload = { filename: file.name, contentType, sizeBytes: file.size };
    let grant;
    if (anon) {
      const res = await fetch('/api/public/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      grant = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(grant.message || `Request failed (${res.status})`);
    } else {
      grant = await api('POST', '/api/uploads', payload);
    }
    renderQuota(grant.quota);

    const form = new FormData();
    for (const [k, v] of Object.entries(grant.upload.fields)) form.append(k, v);
    form.append('file', file);
    const s3res = await fetch(grant.upload.url, { method: 'POST', body: form });
    if (!s3res.ok) throw new Error(`S3 rejected the upload (${s3res.status})`);

    if (anon) saveMyDoc(grant.docId, file.name);
    trackPipeline(grant.docId, anon);
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

async function trackPipeline(docId, anon) {
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
      result.textContent = anon
        ? '✓ Indexed. This document is private to you: it never joins the public list, and only this browser holds its catalog number.'
        : '✓ Indexed. It is now in the searchable list above.';
      result.hidden = false;
      if (!anon) await loadIndex();
      openDoc(docId);
      return;
    }
    if (doc.status === 'REJECTED') {
      result.textContent = `✗ Rejected before OCR: ${doc.rejectReason}`;
      result.hidden = false;
      if (!anon) await loadIndex();
      return;
    }
    if (doc.status === 'FAILED') {
      result.textContent = '✗ The pipeline failed on this document. See its record for details.';
      result.hidden = false;
      if (!anon) await loadIndex();
      return;
    }
  }
  result.textContent = 'Still processing. It will appear in the index when done.';
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
