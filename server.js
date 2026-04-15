// Word Spy — Express + Socket.IO multiplayer server.
//
// All game state lives in memory in the `rooms` map. If the process
// restarts, rooms are gone — that's fine for a casual party game.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const WORD_PAIRS = require('./words');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Plain health check for Render.
app.get('/healthz', (_req, res) => res.send('ok'));

// -------------------------------------------------------------------
// In-memory state
// -------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateCode() {
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Fall back to a 5-char code if 4-char namespace is saturated.
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

const VOTE_SECS = 15;

function makeRoom(code, hostId, hostName, opts) {
  /** @type {Room} */
  const room = {
    code,
    host: hostId,
    // Per-player seconds, applied as each turn's duration directly.
    // Previously this was the total discussion time divided by player count.
    timerSecs: clamp(opts.timerSecs, 10, 300),
    maxPlayers: clamp(opts.maxPlayers, 3, 12),
    showHint: !!opts.showHint,
    // Public servers show up in the lobby browser.
    public: !!opts.public,
    mode: opts.mode === 'draw' ? 'draw' : 'text',
    serverName: sanitizeName(opts.serverName) || `${hostName}'s room`,
    state: 'lobby',
    round: 0,
    // Active players; spectator flag marks those waiting for the next round.
    players: {
      [hostId]: { name: hostName, score: 0, ready: false, spectator: false, joinedAt: Date.now() },
    },
    // Game phase fields, initialized when a round starts:
    spyId: null,
    civilianWord: null,
    spyWord: null,
    category: null,
    // Turn-based discussion
    turnOrder: [],          // shuffled array of player IDs (excluding spectators)
    turnIndex: 0,           // index into turnOrder
    perTurnSecs: 0,         // seconds per player
    turnEndsAt: null,       // timestamp when the current turn expires
    // Voting phase
    votes: {},              // voterId -> targetId (server only; never broadcast)
    votingEndsAt: null,
    tieCount: 0,
    accusedId: null,        // set at results — who the group convicted
    winner: null,           // 'civilians' | 'spy' | null — auto-set by vote outcome
    // Chat + draw state
    chat: [],               // array of { id, playerId, name, text, ts, spectator }
    chatSeq: 0,             // message sequence counter
    drawStrokes: [],        // array of stroke objects for current turn
    // Timeouts
    discussionTimeout: null,
    votingTimeout: null,
  };
  rooms.set(code, room);
  return room;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// -------------------------------------------------------------------
// Public room lobby browser
// -------------------------------------------------------------------

const LOBBY_LIST_ROOM = 'lobby:list';

function roomListSnapshot() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.public) continue;
    const active = activePlayers(r);
    list.push({
      code: r.code,
      name: r.serverName || `${getHostName(r)}'s room`,
      mode: r.mode || 'text',
      state: r.state,
      round: r.round || 0,
      maxPlayers: r.maxPlayers,
      playerCount: active.length,
      spectatorCount: spectators(r).length,
    });
  }
  // Prefer waiting rooms at the top, then in-progress with open slots, then full.
  list.sort((a, b) => {
    const rank = (x) => (x.state === 'lobby' ? 0 : x.playerCount < x.maxPlayers ? 1 : 2);
    return rank(a) - rank(b) || b.playerCount - a.playerCount;
  });
  return list;
}

function getHostName(room) {
  const host = room.players[room.host];
  return host ? host.name : 'Host';
}

function activePlayers(room) {
  return Object.entries(room.players)
    .filter(([, p]) => !p.spectator)
    .map(([id, p]) => ({ id, ...p }));
}

function spectators(room) {
  return Object.entries(room.players)
    .filter(([, p]) => p.spectator)
    .map(([id, p]) => ({ id, ...p }));
}

function broadcastRoomList() {
  io.to(LOBBY_LIST_ROOM).emit('roomListUpdate', roomListSnapshot());
}

// -------------------------------------------------------------------
// Word-reveal filter for chat
// -------------------------------------------------------------------

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Returns true if `message` would reveal `word` (including sub-words and spaced-out variants). */
function revealsWord(message, word) {
  if (!word) return false;
  const norm = normalize(message);
  if (!norm) return false;

  // Full word joined (e.g. "Hot Dog" -> "hotdog")
  const joined = normalize(word);
  if (joined.length >= 3 && norm.includes(joined)) return true;

  // Each sub-word of a multi-word target
  const parts = String(word).split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    for (const p of parts) {
      const np = normalize(p);
      if (np.length >= 3 && norm.includes(np)) return true;
    }
  }
  return false;
}

function playerAssignedWord(room, playerId) {
  if (!room || room.state === 'lobby' || !room.spyId) return null;
  if (playerId === room.spyId) return room.spyWord;
  return room.civilianWord;
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function findRoomForSocket(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (room.players[socketId]) return { code, room };
  }
  return null;
}

// -------------------------------------------------------------------
// Public view — strips secrets before broadcasting
// -------------------------------------------------------------------

function publicView(room) {
  const v = {
    code: room.code,
    host: room.host,
    maxPlayers: room.maxPlayers,
    timerSecs: room.timerSecs,
    showHint: room.showHint,
    public: !!room.public,
    mode: room.mode || 'text',
    serverName: room.serverName || '',
    state: room.state,
    round: room.round,
    players: room.players,
    // Turn-based discussion
    turnOrder: room.turnOrder || [],
    turnIndex: room.turnIndex || 0,
    perTurnSecs: room.perTurnSecs || 0,
    turnEndsAt: room.turnEndsAt,
    // Category shown to all if the host enabled it and a round is active.
    category: room.showHint && room.state !== 'lobby' ? room.category : null,
    tieCount: room.tieCount || 0,
  };

  if (room.state === 'voting') {
    v.votingEndsAt = room.votingEndsAt;
    // Anonymous: expose only the list of voter IDs (so the UI can show
    // ✓ next to names) and the count. Never the target of any vote.
    v.voters = Object.keys(room.votes || {});
  }

  if (room.state === 'results') {
    v.spyId = room.spyId;
    v.civilianWord = room.civilianWord;
    v.spyWord = room.spyWord;
    v.winner = room.winner;
    v.accusedId = room.accusedId;
    // Tally the last round's votes for display (anonymous — just counts per target).
    const tallies = {};
    Object.values(room.votes || {}).forEach((t) => { tallies[t] = (tallies[t] || 0) + 1; });
    v.voteTallies = tallies;
  }

  return v;
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('roomUpdate', publicView(room));
  if (room.public) broadcastRoomList();
}

// -------------------------------------------------------------------
// Game phase transitions
// -------------------------------------------------------------------

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;

  // Promote any spectators to active players at the start of a fresh round.
  Object.values(room.players).forEach((p) => {
    if (p.spectator) p.spectator = false;
  });

  const ids = activePlayers(room).map((p) => p.id);
  if (ids.length < 3) return;

  // Reset per-round chat and draw state.
  room.chat = [];
  room.chatSeq = 0;
  room.drawStrokes = [];

  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  const spyId = ids[Math.floor(Math.random() * ids.length)];

  room.state = 'reveal';
  room.round = (room.round || 0) + 1;
  room.category = pair.category;
  room.civilianWord = pair.civilian;
  room.spyWord = pair.spy;
  room.spyId = spyId;
  room.turnOrder = [];
  room.turnIndex = 0;
  room.perTurnSecs = 0;
  room.turnEndsAt = null;
  room.votes = {};
  room.votingEndsAt = null;
  room.tieCount = 0;
  room.accusedId = null;
  room.winner = null;
  if (room.discussionTimeout) { clearTimeout(room.discussionTimeout); room.discussionTimeout = null; }
  if (room.votingTimeout)     { clearTimeout(room.votingTimeout);     room.votingTimeout = null; }
  ids.forEach((id) => { room.players[id].ready = false; });

  // Private word delivery — each player only gets their own assignment.
  ids.forEach((id) => {
    const isSpy = id === spyId;
    io.to(id).emit('yourWord', {
      word: isSpy ? pair.spy : pair.civilian,
      isSpy,
      category: pair.category,
      showHint: room.showHint,
    });
  });

  broadcastRoom(code);
}

function markReady(code, socketId) {
  const room = rooms.get(code);
  if (!room || room.state !== 'reveal') return;
  if (!room.players[socketId]) return;
  room.players[socketId].ready = true;
  broadcastRoom(code);

  const all = Object.values(room.players);
  if (all.length >= 3 && all.every((p) => p.ready)) {
    startDiscussion(code);
  }
}

function startDiscussion(code) {
  const room = rooms.get(code);
  if (!room) return;

  // Active players only — spectators sit this round out.
  const playerIds = activePlayers(room).map((p) => p.id);
  // Pick a random order — turnOrder[0] is the random starting player.
  room.turnOrder = shuffle(playerIds);
  room.turnIndex = 0;
  // Time per player comes straight from the room setting (default 45s).
  room.perTurnSecs = room.timerSecs;
  room.turnEndsAt = Date.now() + room.perTurnSecs * 1000;
  // New turn means a fresh canvas.
  room.drawStrokes = [];

  room.state = 'discussion';
  broadcastRoom(code);
  scheduleTurnEnd(code);
}

function scheduleTurnEnd(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.discussionTimeout) clearTimeout(room.discussionTimeout);
  const delay = Math.max(0, (room.turnEndsAt || Date.now()) - Date.now());
  room.discussionTimeout = setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.state === 'discussion') advanceTurn(code, null);
  }, delay);
}

function advanceTurn(code, callerId) {
  const room = rooms.get(code);
  if (!room || room.state !== 'discussion') return;
  // If a player triggered this (not the timer), verify they're the current speaker.
  if (callerId !== null && room.turnOrder[room.turnIndex] !== callerId) return;

  if (room.discussionTimeout) {
    clearTimeout(room.discussionTimeout);
    room.discussionTimeout = null;
  }

  // Advance to the next still-present player in the turn order.
  let next = (room.turnIndex || 0) + 1;
  while (next < room.turnOrder.length && !room.players[room.turnOrder[next]]) {
    next++;
  }

  if (next >= room.turnOrder.length) {
    // Everyone has had a turn → go straight to voting.
    startVoting(code);
    return;
  }

  room.turnIndex = next;
  room.turnEndsAt = Date.now() + room.perTurnSecs * 1000;
  // Fresh canvas for the next speaker.
  room.drawStrokes = [];
  io.to(code).emit('drawClear');
  broadcastRoom(code);
  scheduleTurnEnd(code);
}

function startVoting(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.state !== 'discussion' && room.state !== 'voting') return;
  if (room.discussionTimeout) { clearTimeout(room.discussionTimeout); room.discussionTimeout = null; }
  if (room.votingTimeout)     { clearTimeout(room.votingTimeout);     room.votingTimeout = null; }

  room.state = 'voting';
  room.votes = {};
  room.votingEndsAt = Date.now() + VOTE_SECS * 1000;
  broadcastRoom(code);

  room.votingTimeout = setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.state === 'voting') tallyVotes(code);
  }, VOTE_SECS * 1000);
}

function castVote(code, voterId, targetId) {
  const room = rooms.get(code);
  if (!room || room.state !== 'voting') return;
  const voter = room.players[voterId];
  const target = room.players[targetId];
  if (!voter || !target) return;
  if (voter.spectator) return;    // spectators can't vote
  if (target.spectator) return;   // can't vote for a spectator
  if (voterId === targetId) return;
  room.votes[voterId] = targetId;
  broadcastRoom(code);

  // All active players have voted → tally immediately.
  const activeIds = activePlayers(room).map((p) => p.id);
  if (activeIds.length > 0 && activeIds.every((id) => room.votes[id])) {
    tallyVotes(code);
  }
}

function tallyVotes(code) {
  const room = rooms.get(code);
  if (!room || room.state !== 'voting') return;
  if (room.votingTimeout) { clearTimeout(room.votingTimeout); room.votingTimeout = null; }

  const playerIds = activePlayers(room).map((p) => p.id);
  const n = playerIds.length;
  const tallies = {};
  Object.values(room.votes).forEach((t) => { tallies[t] = (tallies[t] || 0) + 1; });

  let maxVotes = 0;
  let topIds = [];
  for (const [id, v] of Object.entries(tallies)) {
    if (v > maxVotes) { maxVotes = v; topIds = [id]; }
    else if (v === maxVotes) topIds.push(id);
  }

  // Strict majority: one person alone, with more than half of all players voting for them.
  const hasStrictMajority = topIds.length === 1 && maxVotes > n / 2;

  if (hasStrictMajority) {
    const accusedId = topIds[0];
    room.accusedId = accusedId;
    if (accusedId === room.spyId) {
      // Civilians caught the spy: +1 each to non-spies.
      playerIds.forEach((id) => {
        if (id !== room.spyId) {
          room.players[id].score = (room.players[id].score || 0) + 1;
        }
      });
      room.winner = 'civilians';
    } else {
      // Wrong accusation: spy wins +2.
      if (room.players[room.spyId]) {
        room.players[room.spyId].score = (room.players[room.spyId].score || 0) + 2;
      }
      room.winner = 'spy';
    }
    room.state = 'results';
    broadcastRoom(code);
  } else {
    // No majority / tie for the top spot → revote.
    room.tieCount = (room.tieCount || 0) + 1;
    room.votes = {};
    room.votingEndsAt = Date.now() + VOTE_SECS * 1000;
    broadcastRoom(code);

    room.votingTimeout = setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.state === 'voting') tallyVotes(code);
    }, VOTE_SECS * 1000);
  }
}

function backToLobby(code, socketId) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.host !== socketId) return;
  room.state = 'lobby';
  room.spyId = null;
  room.civilianWord = null;
  room.spyWord = null;
  room.category = null;
  room.turnOrder = [];
  room.turnIndex = 0;
  room.perTurnSecs = 0;
  room.turnEndsAt = null;
  room.votes = {};
  room.votingEndsAt = null;
  room.tieCount = 0;
  room.accusedId = null;
  room.winner = null;
  if (room.discussionTimeout) { clearTimeout(room.discussionTimeout); room.discussionTimeout = null; }
  if (room.votingTimeout)     { clearTimeout(room.votingTimeout);     room.votingTimeout = null; }
  Object.values(room.players).forEach((p) => { p.ready = false; });
  broadcastRoom(code);
}

// -------------------------------------------------------------------
// Socket handlers
// -------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', (payload = {}, ack) => {
    const name = sanitizeName(payload.name);
    if (!name) return safeAck(ack, { error: 'Please enter your name.' });

    const code = generateCode();
    const room = makeRoom(code, socket.id, name, {
      maxPlayers: payload.maxPlayers,
      timerSecs: payload.timerSecs,
      showHint: payload.showHint,
      public: payload.public,
      mode: payload.mode,
      serverName: payload.serverName,
    });
    socket.join(code);
    safeAck(ack, { code, playerId: socket.id, room: publicView(room) });
    broadcastRoom(code);
    if (room.public) broadcastRoomList();
  });

  socket.on('joinRoom', (payload = {}, ack) => {
    const name = sanitizeName(payload.name);
    const code = String(payload.code || '').trim().toUpperCase();
    if (!name) return safeAck(ack, { error: 'Please enter your name.' });
    if (!code || code.length < 4) return safeAck(ack, { error: 'Enter the room code.' });

    const room = rooms.get(code);
    if (!room) return safeAck(ack, { error: 'Room not found.' });

    // Capacity check counts both active players and waiting spectators.
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return safeAck(ack, { error: 'Room is full.' });
    }
    if (Object.values(room.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return safeAck(ack, { error: 'That name is taken.' });
    }

    // Private rooms require being in lobby state; public rooms let late
    // joiners watch as spectators and get promoted on the next round.
    if (room.state !== 'lobby' && !room.public) {
      return safeAck(ack, { error: 'Game already in progress.' });
    }

    const asSpectator = room.state !== 'lobby';
    room.players[socket.id] = {
      name, score: 0, ready: false, spectator: asSpectator, joinedAt: Date.now(),
    };
    socket.join(code);
    safeAck(ack, {
      code,
      playerId: socket.id,
      room: publicView(room),
      chat: room.chat,
      drawStrokes: room.mode === 'draw' ? room.drawStrokes : [],
    });
    broadcastRoom(code);
    if (room.public) broadcastRoomList();
  });

  // -------- Lobby browser --------

  socket.on('subscribeRoomList', (_p, ack) => {
    socket.join(LOBBY_LIST_ROOM);
    safeAck(ack, roomListSnapshot());
  });
  socket.on('unsubscribeRoomList', () => {
    socket.leave(LOBBY_LIST_ROOM);
  });
  socket.on('listPublicRooms', (_p, ack) => {
    safeAck(ack, roomListSnapshot());
  });

  // -------- Chat --------

  socket.on('chatMessage', (payload = {}, ack) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return safeAck(ack, { error: 'Not in a room.' });
    const { code, room } = found;
    const me = room.players[socket.id];
    if (!me) return safeAck(ack, { error: 'Not in a room.' });

    const text = String(payload.text || '').trim().slice(0, 200);
    if (!text) return safeAck(ack, { error: 'Empty message.' });

    // Word-reveal filter — only applies during active rounds, and only to
    // the player's own assigned word. Spectators can't leak either word
    // (they don't know it anyway) so we don't filter them.
    if (!me.spectator) {
      const myWord = playerAssignedWord(room, socket.id);
      if (myWord && revealsWord(text, myWord)) {
        return safeAck(ack, { error: `Don't say your word or parts of it!` });
      }
    }

    const msg = {
      id: ++room.chatSeq,
      playerId: socket.id,
      name: me.name,
      text,
      ts: Date.now(),
      spectator: !!me.spectator,
    };
    room.chat.push(msg);
    // Cap history so long games don't balloon memory.
    if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);

    io.to(code).emit('chatMessage', msg);
    safeAck(ack, { ok: true });
  });

  // -------- Draw --------

  socket.on('drawStroke', (stroke = {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.mode !== 'draw' || room.state !== 'discussion') return;
    // Only the current speaker can draw.
    if (room.turnOrder[room.turnIndex] !== socket.id) return;

    const clean = {
      color: typeof stroke.color === 'string' ? stroke.color.slice(0, 8) : '#000000',
      size: Number(stroke.size) || 4,
      points: Array.isArray(stroke.points)
        ? stroke.points.slice(0, 2000).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0])
        : [],
    };
    if (clean.points.length < 2) return;
    room.drawStrokes.push(clean);
    // Cap total strokes per turn.
    if (room.drawStrokes.length > 400) room.drawStrokes.shift();
    socket.to(code).emit('drawStroke', clean);
  });

  socket.on('drawClear', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.mode !== 'draw' || room.state !== 'discussion') return;
    if (room.turnOrder[room.turnIndex] !== socket.id) return;
    room.drawStrokes = [];
    io.to(code).emit('drawClear');
  });

  socket.on('startGame', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.host !== socket.id) return;
    if (room.state !== 'lobby') return;
    startRound(code);
  });

  socket.on('revealReady', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    markReady(found.code, socket.id);
  });

  socket.on('endDiscussion', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.host !== socket.id) return;
    if (room.state !== 'discussion') return;
    startVoting(code);
  });

  socket.on('nextTurn', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    advanceTurn(found.code, socket.id);
  });

  socket.on('castVote', (payload = {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    castVote(found.code, socket.id, String(payload.targetId || ''));
  });

  socket.on('nextRound', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.host !== socket.id) return;
    if (room.state !== 'results') return;
    startRound(code);
  });

  socket.on('backToLobby', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    backToLobby(found.code, socket.id);
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const found = findRoomForSocket(socket.id);
  if (!found) return;
  const { code, room } = found;
  const wasPublic = !!room.public;
  delete room.players[socket.id];
  socket.leave(code);

  const remaining = Object.keys(room.players);
  if (remaining.length === 0) {
    if (room.discussionTimeout) clearTimeout(room.discussionTimeout);
    if (room.votingTimeout) clearTimeout(room.votingTimeout);
    rooms.delete(code);
    if (wasPublic) broadcastRoomList();
    return;
  }
  if (room.host === socket.id) {
    remaining.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
    room.host = remaining[0];
  }
  broadcastRoom(code);
  if (wasPublic) broadcastRoomList();
}

function sanitizeName(raw) {
  const name = String(raw || '').trim().slice(0, 16);
  return name || null;
}

function safeAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Word Spy listening on port ${port}`);
});
