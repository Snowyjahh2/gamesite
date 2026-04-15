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
    maxPlayers: clamp(opts.maxPlayers, 3, 12),
    timerSecs: clamp(opts.timerSecs, 30, 600),
    showHint: !!opts.showHint,
    state: 'lobby',
    round: 0,
    players: {
      [hostId]: { name: hostName, score: 0, ready: false, joinedAt: Date.now() },
    },
    // Game phase fields, initialized when a round starts:
    spyId: null,
    civilianWord: null,
    spyWord: null,
    category: null,
    // Turn-based discussion
    turnOrder: [],          // shuffled array of player IDs
    turnIndex: 0,           // index into turnOrder
    perTurnSecs: 0,         // seconds per player (total / N)
    turnEndsAt: null,       // timestamp when the current turn expires
    // Voting phase
    votes: {},              // voterId -> targetId (server only; never broadcast)
    votingEndsAt: null,
    tieCount: 0,
    accusedId: null,        // set at results — who the group convicted
    winner: null,           // 'civilians' | 'spy' | null — auto-set by vote outcome
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
}

// -------------------------------------------------------------------
// Game phase transitions
// -------------------------------------------------------------------

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  const ids = Object.keys(room.players);
  if (ids.length < 3) return;

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

  const playerIds = Object.keys(room.players);
  // Pick a random order — turnOrder[0] is the random starting player.
  room.turnOrder = shuffle(playerIds);
  room.turnIndex = 0;
  // Divide the total discussion time across the players, with a floor so
  // each person gets a playable slice even with many players / short timer.
  room.perTurnSecs = Math.max(10, Math.floor(room.timerSecs / playerIds.length));
  room.turnEndsAt = Date.now() + room.perTurnSecs * 1000;

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
  if (!room.players[voterId] || !room.players[targetId]) return;
  if (voterId === targetId) return; // can't vote for yourself
  room.votes[voterId] = targetId;
  broadcastRoom(code);

  // If every player has cast a vote, end voting immediately.
  const ids = Object.keys(room.players);
  if (ids.length > 0 && ids.every((id) => room.votes[id])) {
    tallyVotes(code);
  }
}

function tallyVotes(code) {
  const room = rooms.get(code);
  if (!room || room.state !== 'voting') return;
  if (room.votingTimeout) { clearTimeout(room.votingTimeout); room.votingTimeout = null; }

  const playerIds = Object.keys(room.players);
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
    });
    socket.join(code);
    safeAck(ack, { code, playerId: socket.id, room: publicView(room) });
    broadcastRoom(code);
  });

  socket.on('joinRoom', (payload = {}, ack) => {
    const name = sanitizeName(payload.name);
    const code = String(payload.code || '').trim().toUpperCase();
    if (!name) return safeAck(ack, { error: 'Please enter your name.' });
    if (!code || code.length < 4) return safeAck(ack, { error: 'Enter the room code.' });

    const room = rooms.get(code);
    if (!room) return safeAck(ack, { error: 'Room not found.' });
    if (room.state !== 'lobby') return safeAck(ack, { error: 'Game already in progress.' });
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return safeAck(ack, { error: 'Room is full.' });
    }
    if (Object.values(room.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return safeAck(ack, { error: 'That name is taken.' });
    }

    room.players[socket.id] = { name, score: 0, ready: false, joinedAt: Date.now() };
    socket.join(code);
    safeAck(ack, { code, playerId: socket.id, room: publicView(room) });
    broadcastRoom(code);
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
  delete room.players[socket.id];
  socket.leave(code);

  const remaining = Object.keys(room.players);
  if (remaining.length === 0) {
    if (room.discussionTimeout) clearTimeout(room.discussionTimeout);
    rooms.delete(code);
    return;
  }
  if (room.host === socket.id) {
    remaining.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
    room.host = remaining[0];
  }
  broadcastRoom(code);
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
