// Landing page — collect create/join intent, save it, hand off to room.html.
// The socket is opened on room.html so navigation doesn't kill the connection.

const el = (id) => document.getElementById(id);

// ---------- Tabs ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    hideError();
  });
});

// ---------- Live labels ----------

const sizeInput = el('create-size');
const sizeLabel = el('size-label');
sizeInput.addEventListener('input', () => { sizeLabel.textContent = sizeInput.value; });

const timerInput = el('create-timer');
const timerLabel = el('timer-label');
const formatTime = (secs) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};
timerInput.addEventListener('input', () => { timerLabel.textContent = formatTime(+timerInput.value); });

// ---------- Join code: force uppercase ----------

const joinCodeInput = el('join-code');
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ---------- Helpers ----------

function showError(msg) {
  const e = el('landing-error');
  e.textContent = msg;
  e.hidden = false;
}
function hideError() { el('landing-error').hidden = true; }

// ---------- Create ----------

el('create-panel').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();

  const name = el('create-name').value.trim();
  if (!name) return showError('Please enter your name.');

  sessionStorage.setItem('ws:intent', 'create');
  sessionStorage.setItem('ws:name', name);
  sessionStorage.setItem('ws:maxPlayers', sizeInput.value);
  sessionStorage.setItem('ws:timerSecs', timerInput.value);
  sessionStorage.setItem('ws:showHint', el('create-hints').checked ? '1' : '0');

  window.location.href = 'room.html';
});

// ---------- Join ----------

el('join-panel').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();

  const name = el('join-name').value.trim();
  const code = el('join-code').value.trim().toUpperCase();

  if (!name) return showError('Please enter your name.');
  if (!code || code.length < 4) return showError('Enter the room code.');

  sessionStorage.setItem('ws:intent', 'join');
  sessionStorage.setItem('ws:name', name);
  sessionStorage.setItem('ws:code', code);

  window.location.href = `room.html?code=${encodeURIComponent(code)}`;
});

// ---------- URL prefill for ?code= ----------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  joinCodeInput.value = urlCode.toUpperCase();
  document.querySelector('.tab[data-tab="join"]').click();
}
