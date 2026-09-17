import { encryptSecret, decryptSecret, readSecretLink } from './crypto.js';

const byId = (id) => document.getElementById(id);
const input = byId('secret-input');
const output = byId('revealed-secret');
const shareLink = byId('share-link');
const createButton = byId('create-button');
const revealButton = byId('reveal-button');
const controls = byId('controls');
const status = byId('status');
const formError = byId('form-error');
const views = ['compose', 'share', 'reveal', 'secret', 'done'];
let recipient = null;
let busy = false;
let generation = 0;
let activeView = 'compose';
let clearTimer;
let deadline = 0;

function setBusy(value) {
  busy = value;
  controls.inert = value;
  controls.setAttribute('aria-busy', String(value));
  input.readOnly = value;
}

function show(view) {
  activeView = view;
  for (const name of views) byId(`${name}-view`).hidden = name !== view;
  byId('secret-form').hidden = view !== 'compose';
  byId('secret-paper').hidden = view !== 'secret';
  byId('done-paper').hidden = view !== 'done';
  status.textContent = '';
  formError.hidden = true;
}

function clearSensitive() {
  clearInterval(clearTimer);
  deadline = 0;
  generation++;
  recipient = null;
  input.value = '';
  output.value = '';
  shareLink.value = '';
  history.replaceState(null, '', location.pathname);
}

function finish(title, message) {
  clearSensitive();
  byId('done-title').textContent = title;
  byId('done-message').textContent = message;
  setBusy(false);
  show('done');
}

function updateSize() {
  const size = new TextEncoder().encode(input.value).length;
  byId('size-note').textContent = `${size.toLocaleString('en-US')} / 4,096 bytes`;
  createButton.disabled = busy || !input.value.trim() || size > 4096;
  formError.hidden = size <= 4096;
  formError.textContent = size > 4096 ? 'Keep it under 4,096 bytes.' : '';
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', credentials: 'omit',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Please try again later.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function newSecret() {
  clearSensitive();
  setBusy(false);
  show('compose');
  updateSize();
}

async function readLink() {
  const fragment = location.hash.slice(1);
  newSecret();
  if (!fragment) return;
  const current = generation;
  setBusy(true);
  try {
    const parsed = await readSecretLink(fragment);
    if (generation !== current) return;
    recipient = parsed;
    revealButton.disabled = false;
    show('reveal');
    setBusy(false);
  } catch {
    if (generation === current) finish('Incomplete.', 'Ask the sender for the complete link.');
  }
}

input.addEventListener('input', updateSize);
byId('secret-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || createButton.disabled) return;
  const current = generation;
  setBusy(true);
  try {
    const encrypted = await encryptSecret(input.value);
    if (generation !== current) return;
    const { id } = await post('/api/secrets', encrypted.payload);
    if (generation !== current) return;
    shareLink.value = `${location.origin}/#${id}.${encrypted.key}`;
    input.value = '';
    show('share');
  } catch (error) {
    if (generation !== current) return;
    formError.textContent = error.message;
    formError.hidden = false;
  } finally {
    if (generation === current) setBusy(false);
  }
});

byId('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    status.textContent = 'Copied. Share privately.';
  } catch {
    shareLink.focus();
    shareLink.select();
    status.textContent = 'Copy the selected link manually.';
  }
});

revealButton.addEventListener('click', async () => {
  if (busy || !recipient) return;
  const current = generation;
  const { id, key } = recipient;
  recipient = null;
  setBusy(true);
  revealButton.disabled = true;
  try {
    const payload = await post('/api/reveal', { id });
    if (generation !== current) return;
    const plaintext = await decryptSecret(payload, key);
    if (generation !== current) return;
    output.value = plaintext;
    show('secret');
    deadline = Date.now() + 60_000;
    byId('countdown').textContent = '60s';
    clearTimer = setInterval(() => {
      byId('countdown').textContent = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 's';
      expireDisplay();
    }, 250);
    setBusy(false);
  } catch (error) {
    if (generation === current) finish('Gone.', error.status === 410 ? error.message : 'Could not reveal this secret. Ask the sender for a new link.');
  }
});

function expireDisplay() {
  if (activeView !== 'secret' || !deadline || Date.now() < deadline) return false;
  finish('Gone.', 'Time’s up. Cleared from this page.');
  return true;
}

byId('copy-secret').addEventListener('click', async () => {
  if (busy || activeView !== 'secret' || expireDisplay()) return;
  const current = generation;
  setBusy(true);
  try {
    await navigator.clipboard.writeText(output.value);
  } catch {
    if (generation !== current) return;
    setBusy(false);
    output.focus();
    output.select();
    status.textContent = 'Copy manually, then tap Clear now.';
    return;
  }
  if (generation === current) finish('Copied. Gone.', 'Your secret is on your clipboard.');
});
byId('clear-secret').addEventListener('click', () => {
  if (!busy) finish('Gone.', 'Nothing left on this page.');
});
function clearPage() {
  if (activeView === 'secret' || activeView === 'reveal') finish('Closed.', 'Not revealed yet? Reopen the original link.');
  else newSecret();
}
window.addEventListener('pagehide', clearPage);
window.addEventListener('pageshow', event => { if (event.persisted) clearPage(); else expireDisplay(); });
document.addEventListener('visibilitychange', expireDisplay);
for (const button of document.querySelectorAll('.start-over')) {
  button.addEventListener('click', newSecret);
}
window.addEventListener('hashchange', readLink);
if (window.isSecureContext && crypto.subtle) readLink();
else finish('A secure connection is needed.', 'Open this page over HTTPS to encrypt and reveal secrets.');
