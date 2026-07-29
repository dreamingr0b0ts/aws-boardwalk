// Alpenglow Records Assistant — zero-build frontend.
// Auth is a plain Cognito InitiateAuth call (USER_PASSWORD_AUTH over TLS), so
// no SDK or bundler is needed; the API is same-origin behind CloudFront /api/*.
//
// Two tiers share this page. Visitors ask 5 curated questions a day with no
// sign-in (chips only; the input stays hidden so nothing typed can be sent).
// Signing in swaps the chips for the free-text form.

const $ = (id) => document.getElementById(id);

let config = null; // { region, userPoolClientId } written at publish time
let idToken = sessionStorage.getItem('gai.idToken') || null;
let tokenExp = Number(sessionStorage.getItem('gai.exp') || 0);
const history = []; // [{role, content}] — capped before send
let docList = []; // reading-room TOC from /api/public/info

init();

function signedIn() {
  return Boolean(idToken && tokenExp * 1000 > Date.now() + 60_000);
}

async function init() {
  config = await (await fetch('/config.json')).json();
  loadPublicStats();
  loadQuestions();
  $('login-form').addEventListener('submit', onLogin);
  $('chat-form').addEventListener('submit', onAsk);
  $('logout-btn').addEventListener('click', logout);
  if (signedIn()) enterSignedIn();
  else enterVisitor();
}

async function loadPublicStats() {
  try {
    const info = await (await fetch('/api/public/info')).json();
    $('stat-docs').textContent = info.corpus.docs;
    $('stat-chunks').textContent = info.corpus.chunks;
    $('stat-model').textContent = 'Haiku 4.5';
    docList = info.corpus.docList || [];
    buildToc();
  } catch {
    /* landing stats are cosmetic */
  }
}

// ---- tiers -----------------------------------------------------------------

function enterVisitor() {
  $('chat-form').hidden = true;
  $('question-chips').hidden = false;
  $('visitor-note').hidden = false;
  $('logout-btn').hidden = true;
  $('login-panel').hidden = false;
  refreshQuota();
}

async function enterSignedIn() {
  $('chat-form').hidden = false;
  $('question-chips').hidden = true;
  $('visitor-note').hidden = true;
  $('logout-btn').hidden = false;
  $('login-panel').hidden = true;
  refreshQuota();
  if (!$('messages').children.length) {
    addBot(
      "Welcome in. Ask about the City of Alpenglow's permits, licenses, inspections, fees, " +
        'or appeals. Answers come straight from the demo handbook, with citations. Try: ' +
        '"How much does a residential deck permit cost?"'
    );
  }
}

async function loadQuestions() {
  try {
    const res = await (await fetch('/api/public/questions')).json();
    const holder = $('question-chips');
    holder.innerHTML = '';
    for (const q of res.questions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (q.offCorpus ? ' off-corpus' : '');
      chip.textContent = q.label;
      chip.title = q.question;
      chip.addEventListener('click', () => askVisitor(q, chip));
      holder.appendChild(chip);
    }
  } catch {
    $('question-chips').textContent = 'The question library could not be loaded.';
  }
}

// ---- quota -----------------------------------------------------------------

async function refreshQuota() {
  try {
    const q = signedIn()
      ? await api('GET', '/api/me/quota')
      : await (await fetch('/api/public/quota')).json();
    renderQuota(q);
  } catch {
    /* non-fatal */
  }
}

function renderQuota(q) {
  if (q.tier === 'visitor') {
    const left = Math.max(0, q.userLimit - q.userUsed);
    $('quota-line').textContent =
      `Free questions today: ${left} of ${q.userLimit} left · no sign-in needed`;
  } else {
    $('quota-line').textContent =
      `Your messages today: ${q.userUsed}/${q.userLimit} · demo-wide budget: ${q.globalUsed}/${q.globalLimit}`;
  }
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
    if (!res.ok || !data.AuthenticationResult) {
      throw new Error(data.message || 'Sign-in failed');
    }
    idToken = data.AuthenticationResult.IdToken;
    tokenExp = JSON.parse(atob(idToken.split('.')[1])).exp;
    sessionStorage.setItem('gai.idToken', idToken);
    sessionStorage.setItem('gai.exp', String(tokenExp));
    $('login-password').value = '';
    enterSignedIn();
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
  sessionStorage.removeItem('gai.idToken');
  sessionStorage.removeItem('gai.exp');
  idToken = null;
  history.length = 0;
  $('messages').innerHTML = '';
  enterVisitor();
}

async function api(method, path, body) {
  if (!signedIn()) {
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

// ---- asking ----------------------------------------------------------------

async function askVisitor(q, chip) {
  const chips = [...document.querySelectorAll('#question-chips .chip')];
  chips.forEach((c) => (c.disabled = true));

  addMsg('user', q.question);
  const pending = addBot('Consulting the records…');
  pending.classList.add('thinking');

  try {
    const res = await fetch('/api/public/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: q.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    pending.remove();
    addAnswer(data);
    renderQuota(data.quota);
  } catch (err) {
    pending.remove();
    addBot(`⚠ ${err.message}`);
    refreshQuota();
  } finally {
    chips.forEach((c) => (c.disabled = false));
  }
}

async function onAsk(e) {
  e.preventDefault();
  const input = $('chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  $('chat-btn').disabled = true;

  addMsg('user', question);
  const pending = addBot('Consulting the records…');
  pending.classList.add('thinking');

  try {
    const res = await api('POST', '/api/chat', { question, history: history.slice(-8) });
    pending.remove();
    addAnswer(res);
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: res.answer });
    renderQuota(res.quota);
  } catch (err) {
    pending.remove();
    addBot(`⚠ ${err.message}`);
  } finally {
    $('chat-btn').disabled = false;
    input.focus();
  }
}

function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('messages').appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

const addBot = (text) => addMsg('bot', text);

function addAnswer(res) {
  const el = addBot(res.answer);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const badge = document.createElement('span');
  badge.className = `badge ${res.confidence}`;
  badge.textContent = `${res.confidence} confidence`;
  meta.appendChild(badge);

  for (const c of res.citations || []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cite';
    chip.textContent = `[${c.n}] ${c.title} · ${c.section}`;
    chip.title = `Open ${c.doc} in the reading room`;
    chip.addEventListener('click', () => openDoc(c.doc, c.section));
    meta.appendChild(chip);
  }

  if (res.cost) {
    const cost = document.createElement('span');
    cost.className = 'cost';
    cost.textContent =
      `${fmtUsd(res.cost.usd)} · ${res.cost.inputTokens} in / ${res.cost.outputTokens} out tok` +
      (res.latencyMs ? ` · ${(res.latencyMs / 1000).toFixed(1)}s` : '');
    cost.title = 'What this answer cost to generate (answer model, list price)';
    meta.appendChild(cost);
  }

  if (res.tier !== 'visitor' && res.messageId) {
    for (const rating of ['up', 'down']) {
      const fb = document.createElement('button');
      fb.className = 'fb';
      fb.type = 'button';
      fb.textContent = rating === 'up' ? '👍' : '👎';
      fb.addEventListener('click', async () => {
        try {
          await api('POST', '/api/feedback', { messageId: res.messageId, rating });
          fb.classList.add('sent');
          fb.disabled = true;
        } catch {
          /* ignore */
        }
      });
      meta.appendChild(fb);
    }
  }

  el.appendChild(meta);
  if (res.passages?.length) el.appendChild(buildGlass(res.passages));
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function fmtUsd(usd) {
  if (!(usd > 0)) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// Retrieval under glass: the passages the cosine search surfaced, their
// similarity, and whether the answer used them.
function buildGlass(passages) {
  const details = document.createElement('details');
  details.className = 'glass';
  const summary = document.createElement('summary');
  summary.textContent = 'How this answer was built';
  details.appendChild(summary);

  const intro = document.createElement('p');
  intro.className = 'glass-intro';
  intro.textContent =
    'The question was embedded (Titan v2, 512 dims) and cosine-matched against every indexed ' +
    'passage. These four scored highest; the answer may cite only these.';
  details.appendChild(intro);

  for (const p of passages) {
    const card = document.createElement('div');
    card.className = 'passage' + (p.cited ? ' cited' : '');

    const head = document.createElement('div');
    head.className = 'passage-head';

    const name = document.createElement('span');
    name.className = 'passage-name';
    name.textContent = `[${p.n}] ${p.title} · ${p.section}`;
    head.appendChild(name);

    const tag = document.createElement('span');
    tag.className = 'ptag' + (p.cited ? ' on' : '');
    tag.textContent = p.cited ? 'cited' : 'not used';
    head.appendChild(tag);
    card.appendChild(head);

    const row = document.createElement('div');
    row.className = 'meter-row';
    row.title = `cosine similarity ${p.score}`;
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, p.score)) * 100)}%`;
    meter.appendChild(fill);
    const score = document.createElement('span');
    score.className = 'meter-score';
    score.textContent = p.score.toFixed(3);
    row.appendChild(meter);
    row.appendChild(score);
    card.appendChild(row);

    const text = document.createElement('p');
    text.className = 'passage-text';
    text.textContent = p.text.length > 240 ? `${p.text.slice(0, 240).trimEnd()}…` : p.text;
    card.appendChild(text);

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'passage-link';
    link.textContent = 'Read the full section in the reading room';
    link.addEventListener('click', () => openDoc(p.doc, p.section));
    card.appendChild(link);

    details.appendChild(card);
  }
  return details;
}

// ---- reading room ----------------------------------------------------------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildToc() {
  const toc = $('doc-toc');
  toc.innerHTML = '';
  for (const d of docList) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip doc-chip';
    chip.textContent = d.title;
    chip.title = `${d.doc} · ${d.sections.length} sections`;
    chip.addEventListener('click', () => openDoc(d.doc));
    toc.appendChild(chip);
  }
}

async function openDoc(doc, section) {
  try {
    const res = await fetch(`/api/public/doc?name=${encodeURIComponent(doc)}`);
    if (!res.ok) throw new Error(`Could not load ${doc}`);
    const data = await res.json();
    renderDoc(doc, data.markdown);
    const view = $('doc-view');
    view.hidden = false;
    [...$('doc-toc').children].forEach((c) => c.classList.toggle('open', c.title.startsWith(`${doc} ·`)));
    const target = section ? document.getElementById(`sec-${slug(section)}`) : view;
    (target || view).scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (section && target) {
      target.classList.remove('flash');
      requestAnimationFrame(() => target.classList.add('flash'));
    }
  } catch {
    /* reading room is a side exhibit; fail quiet */
  }
}

// The corpus is plain markdown: one H1 title, H2 sections, paragraph prose.
// Rendered with textContent throughout, so document content is never
// interpreted as HTML.
function renderDoc(doc, markdown) {
  const body = $('doc-body');
  body.innerHTML = '';
  let title = doc;
  let para = [];

  const flush = () => {
    const text = para.join(' ').trim();
    para = [];
    if (!text) return;
    const p = document.createElement('p');
    p.textContent = text;
    body.appendChild(p);
  };

  for (const line of markdown.split('\n')) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    if (h1) {
      flush();
      title = h1[1].trim();
    } else if (h2) {
      flush();
      const h = document.createElement('h4');
      h.id = `sec-${slug(h2[1].trim())}`;
      h.textContent = h2[1].trim();
      body.appendChild(h);
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  $('doc-title').textContent = title;
}
