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

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Clean URLs: /room → /room.html
app.get('/room', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

// Health check.
app.get('/healthz', (_req, res) => res.send('ok'));

// AI player config — set OPENAI_API_KEY and AI_PASSWORD in Railway env vars.
const AI_PASSWORD = process.env.AI_PASSWORD || 'snowy_pass';
const AI_NAMES = ['Nova', 'Echo', 'Cipher', 'Nexus', 'Spark', 'Axiom'];
const MAX_AI_PER_ROOM = 3;

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
    mode: ['draw', 'text', 'inperson'].includes(opts.mode) ? opts.mode : 'text',
    serverName: sanitizeName(opts.serverName) || `${hostName}'s room`,
    state: 'lobby',
    round: 0,
    // Active players; spectator flag marks those waiting for the next round.
    // preferSpectate is a persistent opt-in: player stays as spectator across rounds.
    players: {
      [hostId]: {
        name: hostName, score: 0, ready: false,
        spectator: false, preferSpectate: false,
        joinedAt: Date.now(),
      },
    },
    // Game phase fields, initialized when a round starts:
    spyId: null,
    civilianWord: null,
    spyWord: null,
    category: null,
    // Turn-based discussion
    turnOrder: [],
    turnIndex: 0,
    turnLap: 1,             // current pass through turnOrder (1 or 2)
    totalLaps: 1,            // private rooms run 2 laps, public rooms run 1
    perTurnSecs: 0,
    turnEndsAt: null,
    // Voting phase
    votes: {},
    votingEndsAt: null,
    tieCount: 0,
    accusedId: null,
    winner: null,           // 'civilians' | 'spy' | 'tie' | null
    // Public lobby auto-start countdown
    countdownEndsAt: null,
    countdownTimeout: null,
    // Public post-results auto-return to lobby
    resultsTimeout: null,
    // Chat + draw state
    chat: [],
    chatSeq: 0,
    drawStrokes: [],
    // Game-phase timeouts
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

/** Pick a word pair that hasn't been used in this room yet.
 *  Resets the history once every pair has been seen. */
function pickFreshPair(room) {
  if (!room.usedPairs) room.usedPairs = new Set();
  if (room.usedPairs.size >= WORD_PAIRS.length) room.usedPairs.clear();

  let idx;
  do {
    idx = Math.floor(Math.random() * WORD_PAIRS.length);
  } while (room.usedPairs.has(idx));

  room.usedPairs.add(idx);
  return WORD_PAIRS[idx];
}

/** Pick a spy who hasn't been spy recently. Everyone gets a turn
 *  before anyone repeats. */
function pickFreshSpy(room, ids) {
  if (!room.recentSpies) room.recentSpies = [];
  // Remove players who left.
  room.recentSpies = room.recentSpies.filter((id) => ids.includes(id));
  // If everyone has been spy, reset.
  if (room.recentSpies.length >= ids.length) room.recentSpies = [];

  const eligible = ids.filter((id) => !room.recentSpies.includes(id));
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  room.recentSpies.push(picked);
  return picked;
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

// -------------------------------------------------------------------
// Public-room auto-start countdown
// -------------------------------------------------------------------

const PUBLIC_COUNTDOWN_SECS = 10;
const PUBLIC_RESULTS_SECS = 8;

function maybeStartPublicCountdown(code) {
  const room = rooms.get(code);
  if (!room || !room.public || room.state !== 'lobby') return;
  const active = activePlayers(room).length;
  if (active < 3) {
    cancelPublicCountdown(code);
    return;
  }
  if (room.countdownEndsAt) return; // already running
  room.countdownEndsAt = Date.now() + PUBLIC_COUNTDOWN_SECS * 1000;
  room.countdownTimeout = setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.state !== 'lobby') return;
    r.countdownEndsAt = null;
    r.countdownTimeout = null;
    startRound(code);
  }, PUBLIC_COUNTDOWN_SECS * 1000);
  broadcastRoom(code);
}

function cancelPublicCountdown(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.countdownTimeout) {
    clearTimeout(room.countdownTimeout);
    room.countdownTimeout = null;
  }
  if (room.countdownEndsAt) {
    room.countdownEndsAt = null;
    broadcastRoom(code);
  }
}

// -------------------------------------------------------------------
// Reset round state (used by backToLobby + public auto-cycle)
// -------------------------------------------------------------------

// -------------------------------------------------------------------
// AI player logic
// -------------------------------------------------------------------

function generateAIId() {
  return 'ai_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function callOpenAI(systemPrompt, userPrompt, maxTokens = 60) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.9,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('OpenAI error:', e.message);
    return null;
  }
}

async function generateAIClue(word, chatHistory, category, isFirstSpeaker) {
  const system = [
    'You are a human player in Word Spy, a social deduction party game.',
    'HOW THE GAME WORKS:',
    '- Every player receives a secret word. Most players get the SAME word (civilians).',
    '- One player (the spy) gets a SIMILAR but DIFFERENT word.',
    '- Nobody knows if they are the spy or a civilian.',
    '- Players take turns giving ONE short vague clue about their word.',
    '- After all clues, players vote on who they think the spy is.',
    '',
    'YOUR STRATEGY:',
    '- Read what other players have said. Their clues hint at what the common word might be.',
    '- Give a clue that is BROAD enough to fit your word, but also sounds like it fits what others are describing.',
    '- If others\' clues seem to match your word well, give a clue that agrees with the theme.',
    '- If others\' clues feel slightly off from your word, you might be the spy — give something vague that could fit both interpretations.',
    '- NEVER say your word directly, or any obvious synonym or substring of it.',
    '- Sound casual and human. One short sentence. No quotes, no "my clue is", just the clue itself.',
    '- Don\'t repeat what others already said. Add something new.',
  ].join('\n');

  let user;
  if (!chatHistory || isFirstSpeaker) {
    user = [
      `Your word is: "${word}".`,
      category ? `Category: ${category}.` : '',
      '',
      'You are the FIRST to speak. Give one short, vague clue about your word.',
      'Be broad — don\'t give away too much since you go first.',
    ].filter(Boolean).join('\n');
  } else {
    user = [
      `Your word is: "${word}".`,
      category ? `Category: ${category}.` : '',
      '',
      'Here is what other players said before you:',
      chatHistory,
      '',
      'Read their clues carefully. Give ONE short clue about YOUR word that sounds like',
      'it fits with what others are describing. Blend in. Add something new, don\'t repeat.',
    ].filter(Boolean).join('\n');
  }

  const result = await callOpenAI(system, user, 50);
  return result || (isFirstSpeaker
    ? "This is something pretty common, most people know about it."
    : "Yeah, I think I know what everyone's getting at here.");
}

async function handleAITurn(code) {
  const room = rooms.get(code);
  if (!room || room.state !== 'discussion') return;
  const currentId = room.turnOrder[room.turnIndex];
  const aiPlayer = room.players[currentId];
  if (!aiPlayer || !aiPlayer.isAI) return;

  const word = currentId === room.spyId ? room.spyWord : room.civilianWord;
  const recent = room.chat.slice(-20).map((m) => `${m.name}: ${m.text}`).join('\n');
  const isFirst = room.chat.filter((m) => !m.spectator).length === 0;
  const clue = await generateAIClue(word, recent, room.showHint ? room.category : null, isFirst);

  // Post as a chat message.
  const msg = {
    id: ++room.chatSeq,
    playerId: currentId,
    name: aiPlayer.name,
    text: clue,
    ts: Date.now(),
    spectator: false,
  };
  room.chat.push(msg);
  if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
  io.to(code).emit('chatMessage', msg);

  // Wait a beat then advance.
  setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.state === 'discussion' && r.turnOrder[r.turnIndex] === currentId) {
      advanceTurn(code, currentId);
    }
  }, 1800);
}

function handleAIReady(code) {
  const room = rooms.get(code);
  if (!room || room.state !== 'reveal') return;
  // Mark all AI players as ready after a short delay.
  setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.state !== 'reveal') return;
    let changed = false;
    activePlayers(r).forEach((p) => {
      if (p.isAI && !r.players[p.id].ready) {
        r.players[p.id].ready = true;
        changed = true;
      }
    });
    if (changed) {
      broadcastRoom(code);
      const all = activePlayers(r);
      if (all.length >= 3 && all.every((p) => r.players[p.id].ready)) {
        startDiscussion(code);
      }
    }
  }, 2000);
}

async function generateAIVote(aiPlayer, aiId, room) {
  const active = activePlayers(room);
  const targets = active.filter((t) => t.id !== aiId);
  if (targets.length === 0) return null;

  const aiWord = aiId === room.spyId ? room.spyWord : room.civilianWord;
  const allChat = room.chat.map((m) => `${m.name}: ${m.text}`).join('\n');

  const playerList = targets.map((t) => `- ${t.name}`).join('\n');

  const system = [
    'You are a player in Word Spy, a social deduction game.',
    'HOW IT WORKS: Everyone got a word. Most players got the SAME word. One player (the spy) got a SIMILAR but different word.',
    'Players gave vague clues about their word. Now you must vote for who you think is the SPY.',
    '',
    'HOW TO DETECT THE SPY:',
    '- The spy\'s clues will be slightly off — they describe something similar but not exactly the same thing.',
    '- Look for clues that are too vague (trying to hide), or that subtly describe a different thing.',
    '- If someone\'s clue doesn\'t quite fit with what everyone else is describing, they might be the spy.',
    '',
    'Reply with ONLY the name of the player you vote for. Nothing else.',
  ].join('\n');

  const user = [
    `Your word was: "${aiWord}".`,
    room.showHint && room.category ? `Category: ${room.category}.` : '',
    '',
    'Here is everything that was said during the discussion:',
    allChat || '(no messages)',
    '',
    'These are the players you can vote for:',
    playerList,
    '',
    'Who do you think is the spy? Reply with ONLY their name:',
  ].filter(Boolean).join('\n');

  const result = await callOpenAI(system, user, 20);
  if (!result) return targets[Math.floor(Math.random() * targets.length)].id;

  // Match the AI's response to an actual player name.
  const cleaned = result.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const match = targets.find((t) => {
    const tName = t.name.replace(/^🤖\s*/, '').toLowerCase().trim();
    return cleaned.includes(tName) || tName.includes(cleaned);
  });
  return match ? match.id : targets[Math.floor(Math.random() * targets.length)].id;
}

function handleAIVotes(code) {
  const room = rooms.get(code);
  if (!room || room.state !== 'voting') return;
  setTimeout(async () => {
    const r = rooms.get(code);
    if (!r || r.state !== 'voting') return;
    const active = activePlayers(r);
    let changed = false;

    for (const p of active) {
      if (!p.isAI || r.votes[p.id]) continue;
      const targetId = await generateAIVote(p, p.id, r);
      if (targetId && r.state === 'voting') {
        r.votes[p.id] = targetId;
        changed = true;
      }
    }

    if (changed && r.state === 'voting') {
      broadcastRoom(code);
      const allVoted = active.every((ap) => r.votes[ap.id]);
      if (allVoted) tallyVotes(code);
    }
  }, 2500);
}

function resetRoundState(room) {
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
  if (room.resultsTimeout)    { clearTimeout(room.resultsTimeout);    room.resultsTimeout = null; }
  Object.values(room.players).forEach((p) => { p.ready = false; });
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
    turnLap: room.turnLap || 1,
    totalLaps: room.totalLaps || 1,
    perTurnSecs: room.perTurnSecs || 0,
    turnEndsAt: room.turnEndsAt,
    // Public lobby auto-start countdown
    countdownEndsAt: room.countdownEndsAt,
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

  // Clear any pending public-lobby countdown or post-results auto-cycle.
  if (room.countdownTimeout) { clearTimeout(room.countdownTimeout); room.countdownTimeout = null; }
  room.countdownEndsAt = null;
  if (room.resultsTimeout) { clearTimeout(room.resultsTimeout); room.resultsTimeout = null; }

  // Apply each player's spectator preference: preferSpectate players become
  // spectators, everyone else becomes active.
  Object.values(room.players).forEach((p) => {
    p.spectator = !!p.preferSpectate;
  });

  const ids = activePlayers(room).map((p) => p.id);
  if (ids.length < 3) return;

  // Reset per-round chat and draw state.
  room.chat = [];
  room.chatSeq = 0;
  room.drawStrokes = [];

  const pair = pickFreshPair(room);
  const spyId = pickFreshSpy(room, ids);

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
  // (AI players have no socket; they store their word internally.)
  ids.forEach((id) => {
    const isSpy = id === spyId;
    const p = room.players[id];
    if (p && p.isAI) {
      p.aiWord = isSpy ? pair.spy : pair.civilian;
    } else {
      io.to(id).emit('yourWord', {
        word: isSpy ? pair.spy : pair.civilian,
        isSpy,
        category: pair.category,
        showHint: room.showHint,
      });
    }
  });

  broadcastRoom(code);

  // AI players auto-ready after a moment.
  handleAIReady(code);
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
  // Private rooms get two passes through the order; public rooms stay at one
  // so the auto-cycle stays quick.
  room.totalLaps = room.public ? 1 : 2;
  room.turnLap = 1;
  // Time per player comes straight from the room setting (default 45s).
  room.perTurnSecs = room.timerSecs;
  room.turnEndsAt = Date.now() + room.perTurnSecs * 1000;
  // New turn means a fresh canvas.
  room.drawStrokes = [];

  room.state = 'discussion';
  broadcastRoom(code);
  scheduleTurnEnd(code);

  // If the first speaker is an AI, trigger their turn.
  const firstId = room.turnOrder[0];
  if (firstId && room.players[firstId] && room.players[firstId].isAI) {
    handleAITurn(code);
  }
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
    // End of the current lap.
    const currentLap = room.turnLap || 1;
    const totalLaps = room.totalLaps || 1;
    if (currentLap < totalLaps) {
      // Start the next lap from the first still-present player.
      room.turnLap = currentLap + 1;
      next = 0;
      while (next < room.turnOrder.length && !room.players[room.turnOrder[next]]) {
        next++;
      }
      if (next >= room.turnOrder.length) {
        startVoting(code);
        return;
      }
    } else {
      // All laps complete → voting.
      startVoting(code);
      return;
    }
  }

  room.turnIndex = next;
  room.turnEndsAt = Date.now() + room.perTurnSecs * 1000;
  // Fresh canvas for the next speaker.
  room.drawStrokes = [];
  io.to(code).emit('drawClear');
  broadcastRoom(code);
  scheduleTurnEnd(code);

  // If the new speaker is an AI, trigger their turn.
  const nextPlayer = room.players[room.turnOrder[next]];
  if (nextPlayer && nextPlayer.isAI) {
    handleAITurn(code);
  }
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

  // AI players auto-vote after a moment.
  handleAIVotes(code);

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
      playerIds.forEach((id) => {
        if (id !== room.spyId) {
          room.players[id].score = (room.players[id].score || 0) + 1;
        }
      });
      room.winner = 'civilians';
    } else {
      if (room.players[room.spyId]) {
        room.players[room.spyId].score = (room.players[room.spyId].score || 0) + 2;
      }
      room.winner = 'spy';
    }
    room.state = 'results';
    scheduleAutoBackToLobby(code);
    broadcastRoom(code);
  } else {
    // No majority / tie for the top spot.
    room.tieCount = (room.tieCount || 0) + 1;

    // Second consecutive tie → end the round as a draw. No points awarded.
    if (room.tieCount >= 2) {
      room.state = 'results';
      room.winner = 'tie';
      room.accusedId = null;
      scheduleAutoBackToLobby(code);
      broadcastRoom(code);
      return;
    }

    // First tie → revote.
    room.votes = {};
    room.votingEndsAt = Date.now() + VOTE_SECS * 1000;
    broadcastRoom(code);

    room.votingTimeout = setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.state === 'voting') tallyVotes(code);
    }, VOTE_SECS * 1000);
  }
}

function scheduleAutoBackToLobby(code) {
  const room = rooms.get(code);
  if (!room || !room.public) return; // only public rooms auto-cycle
  if (room.resultsTimeout) clearTimeout(room.resultsTimeout);
  room.resultsTimeout = setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.state !== 'results') return;
    resetRoundState(r);
    broadcastRoom(code);
    maybeStartPublicCountdown(code);
  }, PUBLIC_RESULTS_SECS * 1000);
}

function backToLobby(code, socketId) {
  const room = rooms.get(code);
  if (!room) return;
  // Public rooms auto-cycle — only private rooms accept manual back-to-lobby.
  if (room.public) return;
  if (room.host !== socketId) return;
  resetRoundState(room);
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
      name, score: 0, ready: false,
      spectator: asSpectator, preferSpectate: false,
      joinedAt: Date.now(),
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
    if (room.public) {
      broadcastRoomList();
      maybeStartPublicCountdown(code);
    }
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

    // Spectators can't chat — it would give away too much once they know
    // things the players don't (future word, spy identity from prior rounds).
    if (me.spectator) {
      return safeAck(ack, { error: 'Spectators can\'t chat during a game.' });
    }

    // Word-reveal filter — only applies during active rounds, and only to
    // the player's own assigned word.
    const myWord = playerAssignedWord(room, socket.id);
    if (myWord && revealsWord(text, myWord)) {
      return safeAck(ack, { error: `Don't say your word or parts of it!` });
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
    // Public rooms are auto-started by the lobby countdown; ignore manual start.
    if (room.public) return;
    if (room.host !== socket.id) return;
    if (room.state !== 'lobby') return;
    startRound(code);
  });

  // -------- AI players (private rooms only) --------

  socket.on('addAI', (payload = {}, ack) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return safeAck(ack, { error: 'Not in a room.' });
    const { code, room } = found;

    // Password gate — 100% server-side, no bypass.
    if (String(payload.password || '') !== AI_PASSWORD) {
      return safeAck(ack, { error: 'Wrong password.' });
    }
    if (room.public) return safeAck(ack, { error: 'AI is only available in private rooms.' });
    if (room.state !== 'lobby') return safeAck(ack, { error: 'Can only add AI in the lobby.' });

    const aiCount = Object.values(room.players).filter((p) => p.isAI).length;
    if (aiCount >= MAX_AI_PER_ROOM) {
      return safeAck(ack, { error: `Max ${MAX_AI_PER_ROOM} AI players per room.` });
    }
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return safeAck(ack, { error: 'Room is full.' });
    }

    const aiId = generateAIId();
    const usedNames = Object.values(room.players).map((p) => p.name.replace(/^🤖\s*/, ''));
    const aiName = AI_NAMES.find((n) => !usedNames.includes(n)) || `Bot ${aiCount + 1}`;

    room.players[aiId] = {
      name: '🤖 ' + aiName,
      score: 0,
      ready: false,
      spectator: false,
      preferSpectate: false,
      isAI: true,
      joinedAt: Date.now(),
    };

    safeAck(ack, { ok: true, aiName });
    broadcastRoom(code);
  });

  socket.on('toggleSpectate', () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    const me = room.players[socket.id];
    if (!me) return;
    me.preferSpectate = !me.preferSpectate;
    // In lobby the toggle is immediate; mid-game it takes effect next round.
    if (room.state === 'lobby') {
      me.spectator = me.preferSpectate;
      broadcastRoom(code);
      if (room.public) {
        if (activePlayers(room).length < 3) cancelPublicCountdown(code);
        else maybeStartPublicCountdown(code);
      }
    } else {
      broadcastRoom(code);
    }
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
    if (room.public) return; // public rooms auto-cycle
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
  const realRemaining = remaining.filter((id) => !room.players[id].isAI);
  if (remaining.length === 0 || realRemaining.length === 0) {
    if (room.discussionTimeout) clearTimeout(room.discussionTimeout);
    if (room.votingTimeout) clearTimeout(room.votingTimeout);
    if (room.countdownTimeout) clearTimeout(room.countdownTimeout);
    if (room.resultsTimeout) clearTimeout(room.resultsTimeout);
    rooms.delete(code);
    if (wasPublic) broadcastRoomList();
    return;
  }
  if (room.host === socket.id) {
    remaining.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
    room.host = remaining[0];
  }
  broadcastRoom(code);
  if (wasPublic) {
    broadcastRoomList();
    // Player count changed — maybe start or cancel the lobby countdown.
    if (room.state === 'lobby') {
      if (activePlayers(room).length < 3) cancelPublicCountdown(code);
      else maybeStartPublicCountdown(code);
    }
  }
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
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Word Spy listening on port ${port}`);
});
