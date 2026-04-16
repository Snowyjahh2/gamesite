// Landing page — live public server browser + create/join forms.
//
// A short-lived Socket.IO connection on the landing page keeps the public
// server list in sync. When the user picks an action we save their intent
// into sessionStorage and navigate to room.html, which opens its own
// long-lived socket for actual gameplay.

/* global io */

const el = (id) => document.getElementById(id);

// ---------- Name field (persisted) ----------

const nameInput = el('your-name');
nameInput.value = sessionStorage.getItem('ws:name') || '';
nameInput.addEventListener('input', () => {
  sessionStorage.setItem('ws:name', nameInput.value.trim());
});

function requireName() {
  const n = nameInput.value.trim();
  if (!n) {
    showError('Please enter your name first.');
    nameInput.focus();
    return null;
  }
  sessionStorage.setItem('ws:name', n);
  return n;
}

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

const joinCodeInput = el('join-code');
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ---------- Errors ----------

function showError(msg) {
  const e = el('landing-error');
  e.textContent = msg;
  e.hidden = false;
}
function hideError() { el('landing-error').hidden = true; }

// ---------- Intent handoff to room.html ----------

function goCreate({ public: isPublic = false, mode = 'text', serverName = '', maxPlayers, timerSecs, showHint }) {
  const name = requireName();
  if (!name) return;
  sessionStorage.setItem('ws:intent', 'create');
  sessionStorage.setItem('ws:name', name);
  sessionStorage.setItem('ws:maxPlayers', String(maxPlayers));
  sessionStorage.setItem('ws:timerSecs', String(timerSecs));
  sessionStorage.setItem('ws:showHint', showHint ? '1' : '0');
  sessionStorage.setItem('ws:public', isPublic ? '1' : '0');
  sessionStorage.setItem('ws:mode', mode);
  sessionStorage.setItem('ws:serverName', serverName);
  window.location.href = 'room.html';
}

function goJoin(code) {
  const name = requireName();
  if (!name) return;
  const c = String(code || '').trim().toUpperCase();
  if (!c || c.length < 4) return showError('Enter a room code.');
  sessionStorage.setItem('ws:intent', 'join');
  sessionStorage.setItem('ws:name', name);
  sessionStorage.setItem('ws:code', c);
  window.location.href = `room.html?code=${encodeURIComponent(c)}`;
}

// ---------- Private create mode toggle ----------

let createMode = 'text';
const modeHints = {
  draw: 'Draw clues on a canvas for others to see.',
  text: 'Text chat is used to discuss clues.',
  inperson: 'All players are in the same room — talk out loud!',
};

document.querySelectorAll('#create-panel .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    createMode = btn.dataset.mode;
    document.querySelectorAll('#create-panel .mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const hint = el('create-mode-hint');
    if (hint) hint.textContent = modeHints[createMode] || '';
  });
});

// ---------- Private create / join ----------

el('create-panel').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();
  goCreate({
    public: false,
    mode: createMode,
    maxPlayers: parseInt(sizeInput.value, 10),
    timerSecs: parseInt(timerInput.value, 10),
    showHint: el('create-hints').checked,
  });
});

el('join-panel').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();
  goJoin(joinCodeInput.value);
});

// ---------- Public server browser ----------

const socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 5 });

function renderServerList(list) {
  const ul = el('server-list');
  ul.innerHTML = '';
  el('public-count').textContent = String(list.length);
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'server-empty';
    li.textContent = 'No public servers yet. Be the first!';
    ul.appendChild(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'server-row';
    const full = s.playerCount >= s.maxPlayers;
    const inProgress = s.state !== 'lobby';
    const statusText = inProgress ? `Round ${s.round || 1}` : 'Waiting';
    const modeBadge = s.mode === 'draw' ? '✏️ Draw' : s.mode === 'inperson' ? '🏠 In Person' : '💬 Text';
    li.innerHTML = `
      <div class="server-meta">
        <div class="server-name">${escapeHtml(s.name || 'Room')}</div>
        <div class="server-sub">
          <span class="server-mode">${modeBadge}</span>
          <span class="server-dot">·</span>
          <span class="server-state">${statusText}</span>
        </div>
      </div>
      <div class="server-count">${s.playerCount}/${s.maxPlayers}</div>
      <button class="btn btn-primary server-join" data-code="${s.code}" ${full ? 'disabled' : ''}>
        ${full ? 'Full' : (inProgress ? 'Watch' : 'Join')}
      </button>
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll('.server-join').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      goJoin(btn.dataset.code);
    });
  });
}

socket.on('connect', () => {
  socket.emit('subscribeRoomList', null, (initial) => {
    if (Array.isArray(initial)) renderServerList(initial);
  });
});

socket.on('roomListUpdate', (list) => {
  if (Array.isArray(list)) renderServerList(list);
});

socket.on('connect_error', () => {
  const ul = el('server-list');
  ul.innerHTML = '<li class="server-empty">Can\'t reach the server. Try refreshing.</li>';
});

// ---------- Public create modal ----------

const modal = el('public-modal');
const pubSize = el('pub-size');
const pubSizeLabel = el('pub-size-label');
pubSize.addEventListener('input', () => { pubSizeLabel.textContent = pubSize.value; });

const pubTimer = el('pub-timer');
const pubTimerLabel = el('pub-timer-label');
pubTimer.addEventListener('input', () => { pubTimerLabel.textContent = formatTime(+pubTimer.value); });

let pubMode = 'text';
document.querySelectorAll('#public-form .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    pubMode = btn.dataset.mode;
    document.querySelectorAll('#public-form .mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const hint = el('pub-mode-hint');
    if (hint) hint.textContent = modeHints[pubMode] || '';
  });
});

el('create-public-btn').addEventListener('click', () => {
  if (!requireName()) return;
  modal.hidden = false;
});

el('pub-cancel').addEventListener('click', () => { modal.hidden = true; });
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.hidden = true;
});

el('public-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = requireName();
  if (!name) return;
  modal.hidden = true;
  goCreate({
    public: true,
    mode: pubMode,
    serverName: el('pub-server-name').value.trim(),
    maxPlayers: parseInt(pubSize.value, 10),
    timerSecs: parseInt(pubTimer.value, 10),
    showHint: el('pub-hints').checked,
  });
});

// ---------- URL prefill for ?code= ----------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  joinCodeInput.value = urlCode.toUpperCase();
  document.querySelector('.tab[data-tab="join"]').click();
}

// ---------- Utility ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
