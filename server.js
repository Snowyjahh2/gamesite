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
    discussionEndsAt: null,
    winner: null, // 'civilians' | 'spy' | null — set by host on the results screen
    discussionTimeout: null,
  };
  rooms.set(code, room);
  return room;
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
    discussionEndsAt: room.discussionEndsAt,
    // Category shown to all if the host enabled it and a round is active.
    category: room.showHint && room.state !== 'lobby' ? room.category : null,
  };
  // Reveal secrets only at results.
  if (room.state === 'results') {
    v.spyId = room.spyId;
    v.civilianWord = room.civilianWord;
    v.spyWord = room.spyWord;
    v.winner = room.winner;
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
  room.discussionEndsAt = null;
  room.winner = null;
  if (room.discussionTimeout) {
    clearTimeout(room.discussionTimeout);
    room.discussionTimeout = null;
  }
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
  room.state = 'discussion';
  room.discussionEndsAt = Date.now() + room.timerSecs * 1000;
  // Reset per-round vote-ready flags.
  Object.values(room.players).forEach((p) => { p.wantsVote = false; });
  broadcastRoom(code);

  if (room.discussionTimeout) clearTimeout(room.discussionTimeout);
  room.discussionTimeout = setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.state === 'discussion') revealSpy(code);
  }, room.timerSecs * 1000);
}

function toggleVoteRequest(code, socketId) {
  const room = rooms.get(code);
  if (!room || room.state !== 'discussion') return;
  if (!room.players[socketId]) return;
  room.players[socketId].wantsVote = !room.players[socketId].wantsVote;
  broadcastRoom(code);

  const all = Object.values(room.players);
  if (all.length >= 3 && all.every((p) => p.wantsVote)) {
    revealSpy(code);
  }
}

function revealSpy(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.state !== 'discussion') return;
  if (room.discussionTimeout) {
    clearTimeout(room.discussionTimeout);
    room.discussionTimeout = null;
  }
  room.state = 'results';
  room.winner = null; // host picks a winner on the results screen (optional)
  broadcastRoom(code);
}

function declareWinner(code, socketId, winner) {
  const room = rooms.get(code);
  if (!room || room.state !== 'results') return;
  if (room.host !== socketId) return;
  if (winner !== 'civilians' && winner !== 'spy') return;
  if (room.winner) return; // already scored this round

  if (winner === 'civilians') {
    Object.keys(room.players).forEach((id) => {
      if (id !== room.spyId) {
        room.players[id].score = (room.players[id].score || 0) + 1;
      }
    });
  } else if (room.players[room.spyId]) {
    room.players[room.spyId].score = (room.players[room.spyId].score || 0) + 2;
  }
  room.winner = winner;
  broadcastRoom(code);
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
  room.discussionEndsAt = null;
  room.winner = null;
  if (room.discussionTimeout) {
    clearTimeout(room.discussionTimeout);
    room.discussionTimeout = null;
  }
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
    revealSpy(code);
  });

  socket.on('requestVote', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    toggleVoteRequest(found.code, socket.id);
  });

  socket.on('declareWinner', (payload = {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    declareWinner(found.code, socket.id, payload.winner);
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
