// Room/game client. Uses Socket.IO (served at /socket.io/socket.io.js).

/* global io */

const el = (id) => document.getElementById(id);

// ---------- Read intent from sessionStorage ----------

const intent = sessionStorage.getItem('ws:intent');
const storedName = sessionStorage.getItem('ws:name');
const storedCode = (new URLSearchParams(location.search).get('code')
  || sessionStorage.getItem('ws:code')
  || '').toUpperCase();

if (!storedName || (!intent && !storedCode)) {
  location.href = 'index.html';
}

// ---------- Socket ----------

const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
});

let myId = null;
let currentRoom = null;
let myWord = null;   // private: { word, isSpy, category, showHint }
let hasFlipped = false;
let timerInterval = null;
let lastView = null;
let joined = false;

// ---------- UI boot ----------

function fail(msg) {
  const e = el('room-error');
  e.textContent = msg;
  e.hidden = false;
}

function bounceHome(delay = 1200) {
  setTimeout(() => { location.href = 'index.html'; }, delay);
}

socket.on('connect', () => {
  if (joined) return; // Don't double-join on reconnect.
  if (intent === 'create') {
    socket.emit('createRoom', {
      name: storedName,
      maxPlayers: parseInt(sessionStorage.getItem('ws:maxPlayers'), 10) || 6,
      timerSecs: parseInt(sessionStorage.getItem('ws:timerSecs'), 10) || 120,
      showHint: sessionStorage.getItem('ws:showHint') === '1',
    }, onJoined);
  } else {
    // Either intent=join or page refresh with stored code.
    if (!storedCode) {
      location.href = 'index.html';
      return;
    }
    socket.emit('joinRoom', { name: storedName, code: storedCode }, onJoined);
  }
});

function onJoined(res) {
  if (!res || res.error) {
    fail(res ? res.error : 'Connection failed.');
    sessionStorage.removeItem('ws:intent');
    bounceHome();
    return;
  }
  joined = true;
  myId = res.playerId;
  currentRoom = res.room;
  sessionStorage.setItem('ws:code', res.code);
  sessionStorage.removeItem('ws:intent'); // consume the intent so refresh re-joins
  // Make URL shareable (replace without reloading).
  const url = new URL(location.href);
  url.searchParams.set('code', res.code);
  history.replaceState(null, '', url.toString());
  el('room-code').textContent = res.code;
  render(res.room);
}

socket.on('disconnect', () => {
  fail('Disconnected. Trying to reconnect…');
});

socket.on('connect_error', (e) => {
  console.error(e);
  fail('Could not connect to the server.');
});

socket.on('roomUpdate', (room) => {
  currentRoom = room;
  el('room-code').textContent = room.code;
  render(room);
});

socket.on('yourWord', (info) => {
  myWord = info;
  hasFlipped = false;
  if (currentRoom && currentRoom.state === 'reveal') render(currentRoom);
});

// ---------- Rendering ----------

function showView(name) {
  if (lastView === name) return;
  lastView = name;
  ['lobby', 'reveal', 'discussion', 'voting', 'results'].forEach((v) => {
    el(`view-${v}`).hidden = v !== name;
  });
  if (name !== 'reveal') hasFlipped = false;
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function render(room) {
  const isHost = room.host === myId;
  const players = sortedPlayers(room);
  el('round-badge').textContent = `Round ${Math.max(1, room.round || 1)}`;

  if (room.state === 'lobby') {
    showView('lobby');
    renderLobby(room, players, isHost);
  } else if (room.state === 'reveal') {
    showView('reveal');
    renderReveal(room, players);
  } else if (room.state === 'discussion') {
    showView('discussion');
    renderDiscussion(room, players, isHost);
  } else if (room.state === 'voting') {
    showView('voting');
    renderVoting(room, players);
  } else if (room.state === 'results') {
    showView('results');
    renderResults(room, players, isHost);
  }
}

// ---------- Lobby ----------

function renderLobby(room, players, isHost) {
  const ul = el('lobby-players');
  ul.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === room.host) li.classList.add('host');
    li.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="pscore">${p.score || 0}</span>`;
    ul.appendChild(li);
  });

  el('lobby-host-controls').hidden = !isHost;
  el('lobby-wait-msg').hidden = isHost;

  const startBtn = el('start-btn');
  const canStart = players.length >= 3 && players.length <= room.maxPlayers;
  startBtn.disabled = !canStart;
  startBtn.textContent = players.length < 3
    ? `Need ${3 - players.length} more player${3 - players.length === 1 ? '' : 's'}`
    : 'Start game';
}

el('start-btn').addEventListener('click', () => {
  socket.emit('startGame');
});

// ---------- Reveal ----------

function renderReveal(room, players) {
  const me = room.players[myId];
  if (!me) return;
  const isSpy = myWord ? myWord.isSpy : false;
  const word = myWord ? myWord.word : '…';
  const category = myWord ? myWord.category : null;

  el('reveal-word').textContent = word;
  const roleEl = el('reveal-role');
  roleEl.textContent = isSpy ? 'You are the SPY' : 'Civilian';
  roleEl.classList.toggle('spy', isSpy);

  const hintEl = el('reveal-hint');
  if (room.showHint && category) {
    hintEl.textContent = `Category: ${category}`;
    hintEl.hidden = false;
  } else {
    hintEl.hidden = true;
  }

  const card = el('reveal-card');
  if (hasFlipped) card.classList.add('flipped');
  else card.classList.remove('flipped');

  const readyBtn = el('ready-btn');
  readyBtn.disabled = !myWord || me.ready || !hasFlipped;
  readyBtn.textContent = me.ready ? 'Waiting for others…' : "I'm ready";

  const readyCount = players.filter((p) => p.ready).length;
  el('ready-count').textContent = readyCount;
  el('ready-total').textContent = players.length;
}

el('reveal-card').addEventListener('click', () => {
  if (!myWord) return;
  hasFlipped = true;
  el('reveal-card').classList.add('flipped');
  if (currentRoom) renderReveal(currentRoom, sortedPlayers(currentRoom));
});

el('ready-btn').addEventListener('click', () => {
  if (!hasFlipped) return;
  socket.emit('revealReady');
});

// ---------- Discussion ----------

function renderDiscussion(room, players, isHost) {
  const ol = el('turn-list');
  ol.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name;
    ol.appendChild(li);
  });

  el('disc-host-controls').hidden = !isHost;
  startTimerTick(room);
}

function startTimerTick(room) {
  stopTimerTick();
  const endsAt = room.discussionEndsAt;
  const total = (room.timerSecs || 120) * 1000;
  const tick = () => {
    const remaining = Math.max(0, (endsAt || 0) - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    el('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    el('timer').classList.toggle('low', secs <= 10);
    el('timer-fill').style.width = `${Math.max(0, (remaining / total) * 100)}%`;
    if (remaining <= 0) stopTimerTick(); // server will advance state
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function stopTimerTick() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

el('vote-now-btn').addEventListener('click', () => {
  socket.emit('forceVote');
});

// ---------- Voting ----------

function renderVoting(room, players) {
  stopTimerTick();
  const votes = room.votes || {};
  const myVote = votes[myId];

  const tallies = {};
  Object.values(votes).forEach((t) => { tallies[t] = (tallies[t] || 0) + 1; });

  const ul = el('vote-list');
  ul.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('self');
    if (myVote === p.id) li.classList.add('selected');
    li.innerHTML = `
      <span class="vname">${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span>
      <span class="vcount">${tallies[p.id] || 0}</span>`;
    li.addEventListener('click', () => {
      if (p.id === myId) return;
      socket.emit('vote', { targetId: p.id });
    });
    ul.appendChild(li);
  });

  const votedCount = Object.keys(votes).length;
  el('voted-count').textContent = votedCount;
  el('voted-total').textContent = players.length;
}

// ---------- Results ----------

function renderResults(room, players, isHost) {
  const votes = room.votes || {};
  const tallies = {};
  Object.values(votes).forEach((t) => { tallies[t] = (tallies[t] || 0) + 1; });
  let maxVotes = 0;
  let topIds = [];
  for (const [id, n] of Object.entries(tallies)) {
    if (n > maxVotes) { maxVotes = n; topIds = [id]; }
    else if (n === maxVotes) topIds.push(id);
  }
  const spyCaught = topIds.length === 1 && topIds[0] === room.spyId;

  const spyPlayer = players.find((p) => p.id === room.spyId);
  el('results-spy-name').textContent = spyPlayer ? spyPlayer.name : 'Unknown';
  el('results-spy-word').textContent = room.spyWord || '—';
  el('results-civ-word').textContent = room.civilianWord || '—';

  const outcome = el('results-outcome');
  if (spyCaught) {
    outcome.textContent = 'Civilians win — the spy was caught!';
    outcome.className = 'results-outcome caught';
  } else {
    outcome.textContent = 'The spy escaped!';
    outcome.className = 'results-outcome escaped';
  }

  const sb = el('scoreboard');
  sb.innerHTML = '';
  const sortedByScore = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topScore = sortedByScore[0] ? sortedByScore[0].score || 0 : 0;
  sortedByScore.forEach((p) => {
    const li = document.createElement('li');
    if ((p.score || 0) === topScore && topScore > 0) li.classList.add('top');
    li.innerHTML = `<span class="sname">${escapeHtml(p.name)}</span><span class="sscore">${p.score || 0}</span>`;
    sb.appendChild(li);
  });

  el('results-host-controls').hidden = !isHost;
}

el('next-round-btn').addEventListener('click', () => {
  socket.emit('nextRound');
});

el('back-lobby-btn').addEventListener('click', () => {
  socket.emit('backToLobby');
});

// ---------- Leave / copy ----------

el('leave-btn').addEventListener('click', (e) => {
  e.preventDefault();
  socket.emit('leaveRoom');
  sessionStorage.removeItem('ws:intent');
  sessionStorage.removeItem('ws:code');
  sessionStorage.removeItem('ws:name');
  sessionStorage.removeItem('ws:maxPlayers');
  sessionStorage.removeItem('ws:timerSecs');
  sessionStorage.removeItem('ws:showHint');
  location.href = 'index.html';
});

el('copy-code').addEventListener('click', async () => {
  const code = el('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    const btn = el('copy-code');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1400);
  } catch {
    prompt('Room code:', code);
  }
});

// ---------- Utilities ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
