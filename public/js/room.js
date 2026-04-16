// Room/game client. Uses Socket.IO (served at /socket.io/socket.io.js).

/* global io */

const el = (id) => document.getElementById(id);

// ---------- Read intent from sessionStorage ----------

const intent = sessionStorage.getItem('ws:intent');
const storedName = localStorage.getItem('ws:name') || sessionStorage.getItem('ws:name');
const storedCode = (new URLSearchParams(location.search).get('code')
  || sessionStorage.getItem('ws:code')
  || '').toUpperCase();

if (!storedName || (!intent && !storedCode)) {
  location.href = '/';
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
let localMyVote = null; // my currently selected voting target (UI highlight only)
let countdownInterval = null; // separate ticker for the public-lobby countdown

// ---------- UI boot ----------

function fail(msg) {
  const e = el('room-error');
  e.textContent = msg;
  e.hidden = false;
}

function bounceHome(delay = 1200) {
  setTimeout(() => { location.href = '/'; }, delay);
}

socket.on('connect', () => {
  if (joined) return; // Don't double-join on reconnect.
  if (intent === 'create') {
    socket.emit('createRoom', {
      name: storedName,
      maxPlayers: parseInt(sessionStorage.getItem('ws:maxPlayers'), 10) || 6,
      timerSecs: parseInt(sessionStorage.getItem('ws:timerSecs'), 10) || 45,
      showHint: sessionStorage.getItem('ws:showHint') === '1',
      public: sessionStorage.getItem('ws:public') === '1',
      mode: sessionStorage.getItem('ws:mode') || 'text',
      serverName: sessionStorage.getItem('ws:serverName') || '',
    }, onJoined);
  } else {
    // Either intent=join or page refresh with stored code.
    if (!storedCode) {
      location.href = '/';
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

  // Replay chat history and current-turn draw strokes for late joiners.
  if (Array.isArray(res.chat)) res.chat.forEach(appendChatMessage);
  if (Array.isArray(res.drawStrokes)) res.drawStrokes.forEach(drawRemoteStroke);
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
  const prevState = currentRoom && currentRoom.state;
  currentRoom = room;
  el('room-code').textContent = room.code;

  // Show the room name at the top if it's a named public server.
  if (room.public && room.serverName) {
    el('room-title-label').textContent = room.serverName;
  } else {
    el('room-title-label').textContent = 'Room code';
  }

  const me = room.players[myId];
  const isSpec = !!(me && me.spectator);
  const prefSpec = !!(me && me.preferSpectate);

  // Spectator banner — visible for actual spectators (not just preferSpectate during lobby).
  el('spectator-banner').hidden = !isSpec;

  // Chat panel: visible for public rooms except inperson mode
  el('chat-panel').hidden = !room.public || room.mode === 'inperson';
  updateChatMeta(room);
  renderSidePlayers(room);
  renderSpectateButton(prefSpec, isSpec);
  updateChatInputState(isSpec);

  render(room);

  // Clear canvas when leaving discussion phase.
  if (prevState === 'discussion' && room.state !== 'discussion') {
    clearCanvas();
  }
});

socket.on('yourWord', (info) => {
  myWord = info;
  hasFlipped = false;
  if (currentRoom && currentRoom.state === 'reveal') render(currentRoom);
});

// ---------- Chat ----------

socket.on('chatMessage', (msg) => {
  appendChatMessage(msg);
});

// ---------- Draw ----------

socket.on('drawStroke', (stroke) => {
  drawRemoteStroke(stroke);
});

socket.on('drawClear', () => {
  clearCanvas();
});

// ---------- Rendering ----------

function showView(name) {
  if (lastView === name) return;
  lastView = name;
  ['lobby', 'reveal', 'discussion', 'voting', 'results'].forEach((v) => {
    el(`view-${v}`).hidden = v !== name;
  });
  if (name !== 'reveal') hasFlipped = false;
  if (name !== 'discussion' && name !== 'voting') stopTimerTick();
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
  const activePlayers = players.filter((p) => !p.spectator);
  activePlayers.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === room.host) li.classList.add('host');
    li.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="pscore">${p.score || 0}</span>`;
    ul.appendChild(li);
  });

  const subtitle = el('lobby-subtitle');
  const countdownWrap = el('public-countdown');
  const hostControls = el('lobby-host-controls');
  const waitMsg = el('lobby-wait-msg');

  // "Add AI" button — private rooms only, while in lobby.
  el('add-ai-row').hidden = !!room.public;

  if (room.public) {
    // Public rooms never show a manual Start button or host wait message.
    hostControls.hidden = true;
    waitMsg.hidden = true;
    subtitle.textContent = 'Public room — the game starts automatically when 3+ players are in.';

    countdownWrap.hidden = false;
    const label = el('public-countdown-label');
    const numEl = el('public-countdown-num');
    if (activePlayers.length < 3) {
      label.textContent = `Waiting for more players… (${activePlayers.length}/3)`;
      numEl.hidden = true;
      stopCountdownTick();
    } else if (room.countdownEndsAt) {
      label.textContent = 'Game starts in';
      numEl.hidden = false;
      startCountdownTick(room.countdownEndsAt);
    } else {
      label.textContent = 'Ready…';
      numEl.hidden = true;
      stopCountdownTick();
    }
  } else {
    // Private room — original flow.
    countdownWrap.hidden = true;
    stopCountdownTick();
    subtitle.textContent = 'Share the room code. The host can start when 3+ players are in.';
    hostControls.hidden = !isHost;
    waitMsg.hidden = isHost;

    const startBtn = el('start-btn');
    const canStart = activePlayers.length >= 3 && activePlayers.length <= room.maxPlayers;
    startBtn.disabled = !canStart;
    startBtn.textContent = activePlayers.length < 3
      ? `Need ${3 - activePlayers.length} more player${3 - activePlayers.length === 1 ? '' : 's'}`
      : 'Start game';
  }
}

function startCountdownTick(endsAt) {
  stopCountdownTick();
  const numEl = el('public-countdown-num');
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    numEl.textContent = String(remaining);
    numEl.classList.toggle('low', remaining <= 3);
    if (remaining <= 0) stopCountdownTick();
  };
  tick();
  countdownInterval = setInterval(tick, 200);
}
function stopCountdownTick() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

el('start-btn').addEventListener('click', () => {
  socket.emit('startGame');
});

el('add-ai-btn').addEventListener('click', () => {
  const pw = prompt('Enter the AI password:');
  if (!pw) return;
  socket.emit('addAI', { password: pw }, (res) => {
    if (res && res.error) {
      alert(res.error);
    }
  });
});

// ---------- Reveal ----------

function renderReveal(room, players) {
  const me = room.players[myId];
  if (!me) return;
  const word = myWord ? myWord.word : '…';
  const category = myWord ? myWord.category : null;

  el('reveal-word').textContent = word;

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
  const order = (room.turnOrder && room.turnOrder.length) ? room.turnOrder : players.map((p) => p.id);
  const turnIndex = room.turnIndex || 0;
  const turnLap = room.turnLap || 1;
  const totalLaps = room.totalLaps || 1;
  const currentId = order[turnIndex];
  const currentPlayer = currentId ? room.players[currentId] : null;

  // Current speaker block
  el('current-speaker-name').textContent = currentPlayer ? currentPlayer.name : '—';

  // Lap badge — only when there's more than one lap
  const lapBadge = el('lap-badge');
  if (lapBadge) {
    if (totalLaps > 1) {
      lapBadge.textContent = `Round ${turnLap}/${totalLaps}`;
      lapBadge.hidden = false;
    } else {
      lapBadge.hidden = true;
    }
  }

  // Speaking-order list — highlight current speaker, grey out past speakers
  const ol = el('turn-list');
  ol.innerHTML = '';
  order.forEach((pid, i) => {
    const p = room.players[pid];
    if (!p) return;
    const li = document.createElement('li');
    li.textContent = p.name;
    if (i < turnIndex) li.classList.add('past-speaker');
    if (i === turnIndex) li.classList.add('current-speaker');
    ol.appendChild(li);
  });

  // Next button — only the current speaker can press it
  const nextBtn = el('next-turn-btn');
  const me = room.players[myId];
  const isSpectator = me && me.spectator;
  const isMyTurn = currentId === myId && !isSpectator;
  // The very last turn is only on the final lap.
  const isFinalTurn = turnIndex === order.length - 1 && turnLap >= totalLaps;
  nextBtn.disabled = !isMyTurn;
  nextBtn.textContent = isMyTurn
    ? (isFinalTurn ? 'Finish · go to vote →' : 'Next →')
    : (isSpectator ? 'Spectating…' : `Waiting for ${currentPlayer ? currentPlayer.name : '…'}`);

  el('disc-host-controls').hidden = !isHost;

  // Discussion subtitle per mode
  const discSub = el('disc-subtitle');
  if (discSub) {
    if (room.mode === 'draw') discSub.textContent = 'Draw clues on the canvas. Don\'t give it away!';
    else if (room.mode === 'inperson') discSub.textContent = 'Talk out loud! Give a vague clue about your word.';
    else discSub.textContent = 'Describe your word in the chat. Don\'t give it away!';
  }

  // Draw stage
  const drawStage = el('draw-stage');
  if (room.mode === 'draw') {
    drawStage.hidden = false;
    el('draw-hint').textContent = isMyTurn
      ? 'You\'re drawing. Others are watching.'
      : `Only ${currentPlayer ? currentPlayer.name : 'the current speaker'} can draw.`;
    // Toggle tool interactivity
    document.querySelectorAll('#draw-tools .tool-btn').forEach((b) => {
      b.disabled = !isMyTurn;
    });
  } else {
    drawStage.hidden = true;
  }

  startTimerTick(
    room.turnEndsAt,
    (room.perTurnSecs || 45) * 1000,
    el('timer'),
    el('timer-fill')
  );
}

function startTimerTick(endsAt, totalMs, timerEl, fillEl) {
  stopTimerTick();
  const tick = () => {
    const remaining = Math.max(0, (endsAt || 0) - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    timerEl.classList.toggle('low', secs <= 10);
    if (fillEl) fillEl.style.width = `${Math.max(0, (remaining / totalMs) * 100)}%`;
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

el('reveal-spy-btn').addEventListener('click', () => {
  socket.emit('endDiscussion');
});

el('next-turn-btn').addEventListener('click', () => {
  socket.emit('nextTurn');
});

// ---------- Voting ----------

function renderVoting(room, players) {
  // Spectators can watch but not vote — only render active players.
  players = players.filter((p) => !p.spectator);
  // Tie banner.
  const banner = el('tie-banner');
  if (room.tieCount && room.tieCount > 0) {
    banner.textContent = `Tie! Revote #${room.tieCount + 1}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  const voters = new Set(room.voters || []);
  const myVote = null; // server doesn't echo my vote back; track locally instead.
  // We still want to highlight the cell I tapped locally. Use localMyVote.

  const ul = el('vote-list');
  ul.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('self');
    if (localMyVote === p.id) li.classList.add('selected');
    const votedBadge = voters.has(p.id) ? '<span class="vcount">voted</span>' : '';
    li.innerHTML = `
      <span class="vname">${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span>
      ${votedBadge}`;
    li.addEventListener('click', () => {
      if (p.id === myId) return;
      localMyVote = p.id;
      socket.emit('castVote', { targetId: p.id });
      renderVoting(currentRoom, sortedPlayers(currentRoom));
    });
    ul.appendChild(li);
  });

  el('voted-count').textContent = voters.size;
  el('voted-total').textContent = players.length;

  startTimerTick(
    room.votingEndsAt,
    15 * 1000,
    el('voting-timer'),
    el('voting-timer-fill')
  );
}

// Reset per-phase local state whenever we leave voting.
function resetLocalVote() { localMyVote = null; }

// ---------- Results ----------

function renderResults(room, players, isHost) {
  const spyPlayer = players.find((p) => p.id === room.spyId);
  const accusedPlayer = players.find((p) => p.id === room.accusedId);
  el('results-spy-name').textContent = spyPlayer ? `The spy was ${spyPlayer.name}` : 'The spy was unknown';
  el('results-spy-word').textContent = room.spyWord || '—';
  el('results-civ-word').textContent = room.civilianWord || '—';
  el('results-accused-name').textContent = accusedPlayer ? accusedPlayer.name : '—';

  const outcome = el('results-outcome');
  if (room.winner === 'civilians') {
    outcome.textContent = 'Civilians win! (+1 each)';
    outcome.className = 'results-outcome caught';
  } else if (room.winner === 'spy') {
    outcome.textContent = 'The impostor wins! (+2)';
    outcome.className = 'results-outcome escaped';
  } else if (room.winner === 'tie') {
    outcome.textContent = 'Vote tied — no winner this round';
    outcome.className = 'results-outcome tied';
  } else {
    outcome.textContent = '';
    outcome.className = 'results-outcome';
  }

  // Public rooms auto-cycle — hide manual nav; private rooms show host controls.
  el('results-nav-controls').hidden = room.public || !isHost;

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

  resetLocalVote();
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
  location.href = '/';
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

// ---------- Chat ----------

function updateChatMeta(room) {
  if (!room) return;
  const active = Object.values(room.players || {}).filter((p) => !p.spectator).length;
  const specs = Object.values(room.players || {}).filter((p) => p.spectator).length;
  const meta = el('chat-meta');
  if (meta) {
    meta.textContent = specs > 0 ? `${active} playing · ${specs} watching` : `${active} playing`;
  }
}

function appendChatMessage(msg) {
  const ul = el('chat-messages');
  if (!ul) return;
  const li = document.createElement('li');
  li.className = 'chat-msg';
  if (msg.spectator) li.classList.add('chat-msg-spec');
  if (msg.playerId === myId) li.classList.add('chat-msg-self');
  li.innerHTML = `
    <span class="chat-author">${escapeHtml(msg.name)}${msg.spectator ? ' <span class="spec-badge">spec</span>' : ''}</span>
    <span class="chat-text">${escapeHtml(msg.text)}</span>
  `;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
  while (ul.children.length > 120) ul.removeChild(ul.firstChild);
}

function showChatWarning(text) {
  const w = el('chat-warning');
  if (!w) return;
  w.textContent = text;
  w.hidden = false;
  setTimeout(() => { w.hidden = true; }, 2600);
}

function renderSidePlayers(room) {
  const playing = el('side-playing');
  const spec = el('side-spec');
  const specWrap = el('side-spec-wrap');
  if (!playing || !spec || !specWrap) return;

  const all = Object.entries(room.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

  const actives = all.filter((p) => !p.spectator);
  const specs = all.filter((p) => p.spectator);

  playing.innerHTML = '';
  actives.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === room.host) li.classList.add('is-host');
    if (p.id === myId) li.classList.add('is-me');
    li.innerHTML = `
      <span class="side-name">${escapeHtml(p.name)}</span>
      <span class="side-score">${p.score || 0}</span>
    `;
    playing.appendChild(li);
  });
  el('side-playing-count').textContent = String(actives.length);

  spec.innerHTML = '';
  specs.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('is-me');
    li.innerHTML = `<span class="side-name">${escapeHtml(p.name)}</span>`;
    spec.appendChild(li);
  });
  el('side-spec-count').textContent = String(specs.length);
  specWrap.hidden = specs.length === 0;
}

function renderSpectateButton(preferSpectate, isSpectator) {
  const btn = el('spectate-btn');
  const label = el('spectate-btn-label');
  if (!btn || !label) return;
  btn.classList.toggle('active', !!preferSpectate);
  if (preferSpectate) {
    label.textContent = isSpectator
      ? '👁️ Spectating — click to rejoin'
      : '👁️ Watching next round — click to cancel';
  } else {
    label.textContent = '👁️ Watch only';
  }
}

function updateChatInputState(isSpectator) {
  const input = el('chat-input');
  const send = el('chat-send');
  if (!input || !send) return;
  input.disabled = !!isSpectator;
  send.disabled = !!isSpectator;
  input.placeholder = isSpectator ? 'Spectating — chat disabled' : 'Type a clue…';
}

const chatForm = el('chat-form');
if (chatForm) {
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { text }, (res) => {
      if (res && res.error) {
        showChatWarning(res.error);
        return;
      }
      input.value = '';
    });
  });
}

const spectateBtn = el('spectate-btn');
if (spectateBtn) {
  spectateBtn.addEventListener('click', () => {
    socket.emit('toggleSpectate');
  });
}

// ---------- Draw canvas ----------

const canvas = el('draw-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false;
let currentStroke = null;
let penColor = '#171510';
let penSize = 4;

function setCanvasBg() {
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function clearCanvas() {
  if (!ctx) return;
  setCanvasBg();
}

if (ctx) {
  setCanvasBg();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const eventToPoint = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
    return [Math.round(x), Math.round(y)];
  };

  const canDraw = () => {
    if (!currentRoom || currentRoom.mode !== 'draw' || currentRoom.state !== 'discussion') return false;
    const order = currentRoom.turnOrder || [];
    return order[currentRoom.turnIndex || 0] === myId;
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!canDraw()) return;
    ev.preventDefault();
    drawing = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    currentStroke = { color: penColor, size: penSize, points: [eventToPoint(ev)] };
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drawing || !currentStroke) return;
    ev.preventDefault();
    const pt = eventToPoint(ev);
    const prev = currentStroke.points[currentStroke.points.length - 1];
    currentStroke.points.push(pt);
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = currentStroke.size;
    ctx.beginPath();
    ctx.moveTo(prev[0], prev[1]);
    ctx.lineTo(pt[0], pt[1]);
    ctx.stroke();
  });
  const endStroke = () => {
    if (!drawing || !currentStroke) { drawing = false; currentStroke = null; return; }
    drawing = false;
    if (currentStroke.points.length >= 2) {
      socket.emit('drawStroke', currentStroke);
    }
    currentStroke = null;
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  document.querySelectorAll('.color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      penColor = btn.dataset.color;
      document.querySelectorAll('.color-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  const setSize = (px, activeId) => {
    penSize = px;
    ['draw-size-sm', 'draw-size-lg'].forEach((id) => {
      const b = el(id);
      if (b) b.classList.toggle('active', id === activeId);
    });
  };
  if (el('draw-size-sm')) el('draw-size-sm').addEventListener('click', () => setSize(3, 'draw-size-sm'));
  if (el('draw-size-lg')) el('draw-size-lg').addEventListener('click', () => setSize(10, 'draw-size-lg'));
  setSize(4, null);

  if (el('draw-clear')) {
    el('draw-clear').addEventListener('click', () => {
      if (!canDraw()) return;
      clearCanvas();
      socket.emit('drawClear');
    });
  }
}

function drawRemoteStroke(stroke) {
  if (!ctx || !stroke || !Array.isArray(stroke.points)) return;
  ctx.strokeStyle = stroke.color || '#000';
  ctx.lineWidth = stroke.size || 4;
  ctx.beginPath();
  for (let i = 0; i < stroke.points.length; i++) {
    const [x, y] = stroke.points[i];
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------- Utilities ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
