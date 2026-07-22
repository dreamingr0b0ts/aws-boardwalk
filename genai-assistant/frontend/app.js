// Alpenglow Records Assistant — zero-build frontend.
// Auth is a plain Cognito InitiateAuth call (USER_PASSWORD_AUTH over TLS), so
// no SDK or bundler is needed; the API is same-origin behind CloudFront /api/*.

const $ = (id) => document.getElementById(id);

let config = null; // { region, userPoolClientId } written at publish time
let idToken = sessionStorage.getItem('gai.idToken') || null;
let tokenExp = Number(sessionStorage.getItem('gai.exp') || 0);
const history = []; // [{role, content}] — capped before send

init();

async function init() {
  config = await (await fetch('/config.json')).json();
  loadPublicStats();
  $('login-form').addEventListener('submit', onLogin);
  $('chat-form').addEventListener('submit', onAsk);
  $('logout-btn').addEventListener('click', logout);
  if (idToken && tokenExp * 1000 > Date.now() + 60_000) {
    showChat();
  }
}

async function loadPublicStats() {
  try {
    const info = await (await fetch('/api/public/info')).json();
    $('stat-docs').textContent = info.corpus.docs;
    $('stat-chunks').textContent = info.corpus.chunks;
    $('stat-model').textContent = 'Haiku 4.5';
  } catch {
    /* landing stats are cosmetic */
  }
}

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
    showChat();
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
  $('chat-panel').hidden = true;
  $('login-panel').hidden = false;
}

async function showChat() {
  $('login-panel').hidden = true;
  $('chat-panel').hidden = false;
  refreshQuota();
  if (!$('messages').children.length) {
    addBot(
      "Welcome in. Ask about the City of Alpenglow's permits, licenses, inspections, fees, " +
        'or appeals. Answers come straight from the demo handbook, with citations. Try: ' +
        '"How much does a residential deck permit cost?"'
    );
  }
}

async function refreshQuota() {
  try {
    const q = await api('GET', '/api/me/quota');
    renderQuota(q);
  } catch {
    /* non-fatal */
  }
}

function renderQuota(q) {
  $('quota-line').textContent =
    `Your messages today: ${q.userUsed}/${q.userLimit} · demo-wide budget: ${q.globalUsed}/${q.globalLimit}`;
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

  for (const c of res.citations) {
    const chip = document.createElement('span');
    chip.className = 'cite';
    chip.textContent = `[${c.n}] ${c.title} · ${c.section}`;
    chip.title = `${c.doc} · retrieval similarity ${c.score}`;
    meta.appendChild(chip);
  }

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

  el.appendChild(meta);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
