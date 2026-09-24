import { encryptSecret, decryptSecret, readSecretLink } from './crypto.js';
import { createPaperMotion } from './paper-motion.js';
import { readWhisperLink } from './whisper-crypto.js';
import { createWhisper, receiveWhisper, whisperSupported } from './whisper.js';

const byId = (id) => document.getElementById(id);
const input = byId('secret-input');
const output = byId('revealed-secret');
const shareLink = byId('share-link');
const copyLinkButton = byId('copy-link');
const createButton = byId('create-button');
const revealButton = byId('reveal-button');
const copyButton = byId('copy-secret');
const controls = byId('controls');
const status = byId('status');
const formError = byId('form-error');
const paper = createPaperMotion(byId('paper-stage'));
const views = ['compose', 'share', 'reveal', 'secret', 'done'];
const labels = { compose: 'Write a secret', share: 'Sealed. Share your link.', reveal: 'A sealed note for you', secret: 'Your secret. Copy before it disappears.', done: 'Cleared' };
let activeView = 'compose';
let recipient = null;
let clearTimer;
let deadline = 0;
let generation = 0;
let busy = false;
let mode = 'letter';
let activeWhisper = null;
let whisperTimer;
let whisperExpiresAt = 0;
const modeToggle = byId('mode-toggle');
const paperStage = byId('paper-stage');
const whisperStage = byId('whisper-stage');
const paperContent = paperStage.querySelector('.paper-content');

function updateWhisperPresentation() {
  whisperStage.dataset.view = activeView;
  whisperStage.dataset.busy = String(busy);
}

function sizeWhisperText() {
  for (const field of [input, output]) {
    field.style.removeProperty('height');
    if (mode !== 'whisper' || !field.clientWidth) continue;
    field.style.height = '0px';
    field.style.height = `${field.scrollHeight}px`;
  }
}
new ResizeObserver(sizeWhisperText).observe(byId('whisper-content'));

function updateMode() {
  const live = mode === 'whisper';
  document.body.dataset.mode = mode;
  paperStage.hidden = live;
  whisperStage.hidden = !live;
  // Move the existing fields, so there is only one copy of sensitive text in the DOM.
  const content = live ? byId('whisper-content') : paperContent;
  content.append(byId('secret-form'), byId('secret-paper'));
  (live ? whisperStage : paperStage).append(byId('done-paper'));
  modeToggle.textContent = live ? 'Sealed Letter ↗' : 'try Whisper ↗';
  byId('compose-detail').textContent = mode === 'whisper'
    ? 'Live delivery. No message stored on our servers.' : 'Encrypted in your browser. Retrievable once.';
  byId('reveal-detail').textContent = mode === 'whisper'
    ? 'The sender must be online. Connect when you are ready to receive.'
    : 'Anyone with this link can open it. Reveal only when ready.';
  byId('mode-footer').textContent = mode === 'whisper'
    ? 'Encrypted · Both online · 10min expiry'
    : 'Encrypted · One retrieval · 24h expiry';
  byId('share-cancel').firstElementChild.textContent = mode === 'whisper' ? 'Cancel whisper' : 'New secret';
  createButton.firstElementChild.textContent = mode === 'whisper' ? 'Whisper a secret' : 'Seal secret';
  byId('clear-secret').firstElementChild.textContent = live ? 'Let it go' : 'Burn now';
  updateWhisperPresentation();
  sizeWhisperText();
}

function setBusy(value) {
  busy = value;
  controls.inert = value;
  controls.setAttribute('aria-busy', String(value));
  input.readOnly = value;
  modeToggle.disabled = value || !['compose', 'done'].includes(activeView);
  updateWhisperPresentation();
}

function show(view) {
  activeView = view;
  modeToggle.disabled = busy || !['compose', 'done'].includes(view);
  updateWhisperPresentation();
  for (const name of views) byId(`${name}-view`).hidden = name !== view;
  byId('secret-form').hidden = view !== 'compose';
  byId('secret-paper').hidden = view !== 'secret';
  byId('done-paper').hidden = view !== 'done';
  byId('step-label').textContent = mode === 'whisper' && view === 'share' ? 'Whisper ready. Share your link.'
    : mode === 'whisper' && view === 'reveal' ? 'A whisper for you' : labels[view];
  status.textContent = '';
  formError.hidden = true;
  if (view === 'share') {
    copyLinkButton.firstElementChild.textContent = 'Copy link';
    copyLinkButton.disabled = false;
  }
  if (view === 'done') {
    const heading = byId('done-title');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function clearSensitive({ keepPaper = false } = {}) {
  generation++;
  activeWhisper?.close();
  activeWhisper = null;
  clearInterval(whisperTimer);
  whisperExpiresAt = 0;
  byId('whisper-wait').hidden = true;
  clearInterval(clearTimer);
  deadline = 0;
  recipient = null;
  input.value = '';
  if (!keepPaper) output.value = '';
  shareLink.value = '';
  history.replaceState(null, '', location.pathname);
}

function prepareDone(title, message) {
  byId('done-title').textContent = title;
  byId('done-message').textContent = message;
  byId('done-paper').hidden = false;
}

function showDone(title, message) {
  prepareDone(title, message);
  setBusy(false);
  show('done');
}

function finish(title, message) {
  clearSensitive();
  paper.reset('gone');
  showDone(title, message);
}

async function burnAndFinish(title, message) {
  if (mode === 'whisper') {
    finish(title, message);
    return;
  }
  clearSensitive({ keepPaper: true });
  const current = generation;
  setBusy(true);
  copyButton.firstElementChild.textContent = 'Burning…';
  byId('step-label').textContent = 'Burning the paper';
  prepareDone(title, message);
  try {
    await paper.burn();
  } catch {
    if (generation === current) paper.reset('gone');
  } finally {
    if (generation === current) {
      output.value = '';
      showDone(title, message);
    }
  }
}

function expireDisplay() {
  if (activeView !== 'secret' || !deadline || Date.now() < deadline) return false;
  finish('Gone.', 'Time’s up. Cleared from this page.');
  return true;
}

function updateSize() {
  sizeWhisperText();
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
  let result;
  try { result = await response.json(); }
  catch { throw new TypeError('The server returned an invalid response.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('The server returned an invalid response.');
  }
  if (!response.ok) {
    const error = new Error(result.error || 'Please try again later.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function newSecret() {
  clearSensitive();
  paper.reset();
  setBusy(false);
  updateMode();
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
    const live = fragment.startsWith('live.');
    const parsed = live ? readWhisperLink(fragment) : await readSecretLink(fragment);
    if (generation !== current) return;
    mode = live ? 'whisper' : 'letter';
    updateMode();
    if (live && !whisperSupported()) {
      finish('Whisper unavailable.', 'Use a browser with WebRTC over HTTPS, or ask for a Sealed Letter.');
      return;
    }
    recipient = { ...parsed, mode };
  } catch {
    if (generation === current) finish('Incomplete.', 'Ask the sender for the complete link.');
    return;
  }
  revealButton.disabled = false;
  revealButton.firstElementChild.textContent = mode === 'whisper' ? 'Receive whisper' : 'Reveal once';
  paper.reset('folded');
  show('reveal');
  setBusy(false);
}

input.addEventListener('input', updateSize);
modeToggle.addEventListener('click', () => {
  if (busy || !['compose', 'done'].includes(activeView)) return;
  mode = mode === 'letter' ? 'whisper' : 'letter';
  if (activeView === 'done') { newSecret(); input.focus({ preventScroll: true }); return; }
  paper.reset();
  updateMode();
  show('compose');
  updateSize();
  input.focus({ preventScroll: true });
});

function updateWhisperCountdown() {
  activeWhisper?.checkDeadline();
  if (!whisperExpiresAt) return;
  const seconds = Math.max(0, Math.ceil((whisperExpiresAt - Date.now()) / 1000));
  byId('whisper-countdown').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function startWhisper(current) {
  // Keep the gathered field hidden while the signaling connection is starting.
  byId('secret-form').hidden = true;
  activeWhisper = createWhisper(input.value, {
    ready: ({ fragment, expiresAt }) => {
      if (generation !== current) return;
      shareLink.value = `${location.origin}/#${fragment}`;
      whisperExpiresAt = expiresAt;
      byId('whisper-progress').textContent = 'Waiting for your recipient. Keep this tab open and connected.';
      updateWhisperCountdown();
      whisperTimer = setInterval(updateWhisperCountdown, 1000);
      setBusy(false);
      show('share');
      byId('whisper-wait').hidden = false;
    },
    progress: (message) => {
      if (generation === current) byId('whisper-progress').textContent = message;
    },
    delivered: () => {
      if (generation === current) void burnAndFinish('Delivered.', 'Your whisper reached the other browser. Cleared from this page.');
    },
    error: (message) => {
      if (generation === current) finish('Whisper ended.', message);
    },
  });
  input.value = '';
}

byId('secret-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || createButton.disabled) return;
  const current = generation;
  setBusy(true);
  createButton.disabled = true;
  createButton.firstElementChild.textContent = mode === 'whisper' ? 'Preparing whisper…' : 'Sealing…';
  formError.hidden = true;
  if (mode === 'whisper') {
    try {
      if (generation === current) startWhisper(current);
    } catch {
      if (generation === current) finish('Whisper unavailable.', 'Use a browser with WebRTC over HTTPS, or create a Sealed Letter.');
    }
    return;
  }
  try {
    const encrypted = await encryptSecret(input.value);
    if (generation !== current) return;
    const { id } = await post('/api/secrets', encrypted.payload);
    if (generation !== current) return;
    shareLink.value = `${location.origin}/#${id}.${encrypted.key}`;
    await paper.fold();
    if (generation !== current) return;
    input.value = '';
    show('share');
  } catch (error) {
    if (generation !== current) return;
    formError.textContent = error instanceof TypeError || error.name === 'TimeoutError'
      ? 'Could not seal your note. Check your connection and try again.' : error.message;
    formError.hidden = false;
  } finally {
    if (generation === current) {
      setBusy(false);
      createButton.firstElementChild.textContent = 'Seal secret';
      createButton.disabled = !input.value.trim() || new TextEncoder().encode(input.value).length > 4096;
    }
  }
});

async function showReceivedSecret(plaintext, current) {
  if (generation !== current) return;
  output.value = plaintext;
  const displaySeconds = mode === 'whisper' ? 15 : 60;
  deadline = Date.now() + displaySeconds * 1000;
  byId('countdown').textContent = `${displaySeconds}s`;
  copyButton.firstElementChild.textContent = mode === 'whisper' ? 'Copy & clear' : 'Copy & burn';
  show('secret');
  sizeWhisperText();
  clearTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    byId('countdown').textContent = `${remaining}s`;
    if (!remaining) {
      if (document.hidden) finish('Gone.', 'Time’s up. Cleared from this page.');
      else void burnAndFinish('Gone.', 'Time’s up. Cleared from this page.');
    }
  }, 250);
  if (mode === 'letter') await paper.unfold();
  if (generation === current) setBusy(false);
}

copyLinkButton.addEventListener('click', async () => {
  if (busy || activeView !== 'share' || copyLinkButton.disabled) return;
  const current = generation;
  copyLinkButton.disabled = true;
  try {
    await navigator.clipboard.writeText(shareLink.value);
  } catch {
    if (generation !== current) return;
    copyLinkButton.firstElementChild.textContent = 'Copy link';
    shareLink.focus();
    shareLink.select();
    status.textContent = 'Copy the selected link manually.';
    return;
  } finally {
    if (generation === current) copyLinkButton.disabled = false;
  }
  if (generation !== current) return;
  copyLinkButton.firstElementChild.textContent = 'Link copied';
  status.textContent = 'Copied. Share privately.';
  if (mode === 'letter') paper.lift();
});

revealButton.addEventListener('click', async () => {
  if (busy || !recipient || revealButton.disabled) return;
  const current = generation;
  const { id, key, secret, mode: recipientMode } = recipient;
  recipient = null;
  setBusy(true);
  revealButton.disabled = true;
  revealButton.firstElementChild.textContent = recipientMode === 'whisper' ? 'Connecting…' : 'Opening…';
  if (recipientMode === 'whisper') {
    activeWhisper = receiveWhisper(id, secret, {
      received: (plaintext) => {
        void showReceivedSecret(plaintext, current).catch(() => {
          if (generation === current) finish('Gone.', 'The page could not display this whisper. Ask for a new one.');
        });
      },
      error: (message) => {
        if (generation === current) finish('Whisper ended.', message);
      },
    });
    return;
  }
  try {
    const payload = await post('/api/reveal', { id });
    if (generation !== current) return;
    const plaintext = await decryptSecret(payload, key);
    if (generation !== current) return;
    await showReceivedSecret(plaintext, current);
  } catch (error) {
    if (generation !== current) return;
    if (error.status === 410) {
      clearSensitive();
      const ashGeneration = generation;
      revealButton.firstElementChild.textContent = 'Only ashes…';
      byId('step-label').textContent = 'The note dissolves into ashes';
      prepareDone('Only ashes.', error.message);
      await paper.ash();
      if (generation === ashGeneration) showDone('Only ashes.', error.message);
      return;
    }
    const message = error.name === 'OperationError'
      ? 'The link could not decrypt this secret. Ask the sender for a new one.'
      : error instanceof TypeError || error.name === 'TimeoutError'
        ? 'The connection failed. The link may already be burned; ask the sender for a new one.'
        : error.message;
    finish('Gone.', message);
  }
});

async function copyAndClear() {
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
    status.textContent = mode === 'whisper' ? 'Copy manually before the whisper disappears.' : 'Copy manually, then tap “Burn now.”';
    return;
  }
  if (generation === current) await burnAndFinish('Copied. Gone.', 'Your secret is on your clipboard.');
}
copyButton.addEventListener('click', copyAndClear);

byId('clear-secret').addEventListener('click', () => {
  if (mode === 'whisper') { void copyAndClear(); return; }
  if (!busy) void burnAndFinish('Gone.', 'Nothing left on this page.');
});
for (const button of document.querySelectorAll('.start-over')) {
  button.addEventListener('click', () => { newSecret(); input.focus({ preventScroll: true }); });
}
window.addEventListener('hashchange', readLink);
function clearPage() {
  if (activeView === 'secret' || activeView === 'reveal') finish('Closed.', 'Not revealed yet? Reopen the original link.');
  else newSecret();
}
window.addEventListener('pagehide', clearPage);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) clearPage();
  else { updateWhisperCountdown(); expireDisplay(); }
});
document.addEventListener('visibilitychange', () => { updateWhisperCountdown(); expireDisplay(); });
if (window.isSecureContext && crypto.subtle) readLink();
else finish('A secure connection is needed.', 'Open this page over HTTPS to encrypt and reveal secrets.');
