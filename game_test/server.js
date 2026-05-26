const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });
app.use(express.static('public', { maxAge: 0, etag: false }));

// ─── Config ────────────────────────────────────────────────
const COLS = 70, ROWS = 70, TICK_MS = 130;
const FOOD_COUNT = 50, RESPAWN_DELAY = 2000;
const ROUND_DURATION = 5 * 60 * 1000; // 5 min
const SPRINT_COST = 2;

const COLORS = [
  '#e74c3c','#2ecc71','#3498db','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#ff6b81','#00d2d3','#95e600','#e056fd','#54a0ff',
];

// ─── Global game state ─────────────────────────────────────
const snakes = new Map();      // socketId -> snake
const food = new Map();        // cellKey -> {x,y,color}
const profiles = new Map();    // socketId -> {name,color,skin}

let gameLoop = null;
let timerIv = null;
let state = 'waiting';         // waiting | playing | ended
let remaining = ROUND_DURATION;
let startAt = 0;

// ─── Helpers ───────────────────────────────────────────────
function ck(x, y) { return `${x},${y}`; }

function randCell() {
  const occ = new Set();
  for (const s of snakes.values()) if (s.alive) for (const g of s.body) occ.add(ck(g.x, g.y));
  for (const k of food.keys()) occ.add(k);
  const free = [];
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!occ.has(ck(x, y))) free.push({ x, y });
  return free.length ? free[Math.random() * free.length | 0] : null;
}

function spawnFood() {
  while (food.size < FOOD_COUNT) { const c = randCell(); if (!c) break; food.set(ck(c.x, c.y), { x: c.x, y: c.y, color: COLORS[Math.random() * COLORS.length | 0] }); }
}

function makeSnake(id) {
  const p = profiles.get(id) || {};
  let x, y, a = 0;
  do { x = 5 + Math.random() * (COLS - 10) | 0; y = 5 + Math.random() * (ROWS - 10) | 0; a++; } while (a < 50 && nearSnake(x, y, 5));
  const dirs = ['right','left','down','up'], dir = dirs[Math.random() * 4 | 0];
  const body = [];
  for (let i = 0; i < 3; i++) {
    switch (dir) {
      case 'right': body.push({ x: x - i, y }); break;
      case 'left':  body.push({ x: x + i, y }); break;
      case 'up':    body.push({ x, y: y + i }); break;
      case 'down':  body.push({ x, y: y - i }); break;
    }
  }
  return { id, body, dir, nextDir: dir, alive: true, score: 0, color: p.color || '#2ecc71', skin: p.skin || 'classic', name: p.name || 'Player', sprinting: false };
}

function nearSnake(x, y, d) {
  for (const s of snakes.values()) if (s.alive) for (const g of s.body) if (Math.abs(g.x - x) + Math.abs(g.y - y) < d) return true;
  return false;
}

function getState() {
  return {
    snakes: [...snakes.values()].map(s => ({ id: s.id, body: s.body, color: s.color, skin: s.skin, alive: s.alive, score: s.score, name: s.name })),
    food: [...food.values()],
    cols: COLS, rows: ROWS,
    state, remaining,
  };
}

// ─── Game lifecycle ────────────────────────────────────────
function startGame() {
  if (state === 'playing') return;
  state = 'playing'; remaining = ROUND_DURATION; startAt = Date.now();
  food.clear();
  for (const s of snakes.values()) { s.score = 0; s.body = makeSnake(s.id).body; s.alive = true; }
  spawnFood();
  gameLoop = setInterval(tick, TICK_MS);
  timerIv = setInterval(() => {
    remaining = ROUND_DURATION - (Date.now() - startAt);
    if (remaining <= 0) return endGame();
    io.emit('timer', { remaining });
  }, 1000);
  io.emit('game-start', { remaining });
  io.emit('state', getState());
}

function endGame() {
  state = 'ended';
  clearInterval(gameLoop); gameLoop = null;
  clearInterval(timerIv); timerIv = null;
  let winner = null, hs = -1;
  for (const s of snakes.values()) if (s.score > hs) { hs = s.score; winner = s; }
  io.emit('game-over', {
    winner: winner ? { id: winner.id, name: winner.name, score: winner.score, color: winner.color } : null,
    scores: [...snakes.values()].map(s => ({ id: s.id, name: s.name, score: s.score, color: s.color })),
  });
  setTimeout(() => {
    if (state === 'ended') {
      state = 'waiting';
      if (snakes.size > 0) startGame();
      else io.emit('state', getState());
    }
  }, 10000);
}

// ─── Tick ──────────────────────────────────────────────────
function tick() {
  const deaths = [];

  // Normal move
  for (const s of snakes.values()) {
    if (!s.alive) continue;
    s.dir = s.nextDir;
    const h = move(s);
    foodCheck(s, h);
    if (deathCheck(s, h)) { deaths.push(s); continue; }
  }

  // Sprint move
  for (const s of snakes.values()) {
    if (!s.alive || !s.sprinting || s.score < SPRINT_COST) continue;
    s.score -= SPRINT_COST;
    const h = move(s);
    foodCheck(s, h);
    if (deathCheck(s, h)) { if (!deaths.includes(s)) deaths.push(s); continue; }
    for (let i = 0; i < SPRINT_COST && s.body.length > 2; i++) s.body.pop();
  }

  // Snake-snake collision
  for (const s of snakes.values()) {
    if (!s.alive || deaths.includes(s)) continue;
    const h = s.body[0];
    for (const o of snakes.values()) {
      if (o === s || !o.alive) continue;
      for (let i = 0; i < o.body.length; i++)
        if (h.x === o.body[i].x && h.y === o.body[i].y) { s.alive = false; deaths.push(s); break; }
      if (!s.alive) break;
    }
  }

  // Death → food
  for (const s of deaths) {
    io.emit('player-died', { id: s.id, name: s.name, score: s.score });
    for (const g of s.body) { const k = ck(g.x, g.y); if (!food.has(k)) food.set(k, { x: g.x, y: g.y, color: s.color }); }
  }

  // Respawn
  for (const s of deaths) {
    setTimeout(() => {
      if (snakes.has(s.id) && state === 'playing') {
        const ns = makeSnake(s.id); ns.score = s.score;
        snakes.set(s.id, ns);
        io.emit('player-respawn', { id: s.id });
      }
    }, RESPAWN_DELAY);
  }

  io.emit('state', getState());
}

function move(s) {
  const h = { ...s.body[0] };
  switch (s.dir) { case 'right': h.x++; break; case 'left': h.x--; break; case 'down': h.y++; break; case 'up': h.y--; break; }
  s.body.unshift(h); return h;
}

function foodCheck(s, h) {
  const k = ck(h.x, h.y);
  if (food.has(k)) { food.delete(k); s.score++; spawnFood(); } else s.body.pop();
}

function deathCheck(s, h) {
  if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS) { s.alive = false; return true; }
  for (let i = 1; i < s.body.length; i++) if (s.body[i].x === h.x && s.body[i].y === h.y) { s.alive = false; return true; }
  return false;
}

// ─── Socket ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  profiles.set(socket.id, { name: 'Player', color: '#2ecc71', skin: 'classic' });
  socket.emit('welcome', { id: socket.id });

  socket.on('join', (data) => {
    const p = profiles.get(socket.id); if (!p) return;
    if (data) {
      if (data.name) p.name = data.name.substring(0, 16);
      if (data.color) p.color = data.color;
      if (data.skin) p.skin = data.skin;
    }
    if (snakes.has(socket.id)) snakes.delete(socket.id);
    snakes.set(socket.id, makeSnake(socket.id));
    socket.emit('init', { id: socket.id, state: getState() });
    if (state !== 'playing') startGame();
    else io.emit('state', getState());
  });

  socket.on('dir', (dir) => {
    const s = snakes.get(socket.id); if (!s || !s.alive) return;
    const opp = { up:'down', down:'up', left:'right', right:'left' };
    if (dir !== opp[s.dir]) s.nextDir = dir;
  });

  socket.on('sprint', (active) => {
    const s = snakes.get(socket.id); if (!s || !s.alive) return;
    s.sprinting = active;
  });

  // ══════════════════════════════════════════════════════════
  // DOUDIZHU Room Management
  // ══════════════════════════════════════════════════════════

  socket.on('ddz:get-rooms', () => {
    const list = [];
    for (const r of ddzRooms.values()) {
      list.push({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state });
    }
    socket.emit('ddz:room-list', list);
  });

  socket.on('ddz:create-room', (data) => {
    // Leave existing room first
    ddzLeaveRoom(socket.id);
    const id = 'ddz-' + (++ddzRoomId);
    const room = { id, name: data?.name || '房间', hostId: socket.id, players: [], state: 'waiting' };
    const p = profiles.get(socket.id) || {};
    room.players.push({ id: socket.id, name: p.name || 'Player', color: p.color || '#2ecc71', skin: p.skin || 'classic' });
    ddzRooms.set(id, room);
    ddzPlayerRoom.set(socket.id, id);
    socket.emit('ddz:room-joined', { roomId: id });
    socket.join(id);
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
    io.to(id).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
  });

  socket.on('ddz:join-room', (roomId) => {
    const room = ddzRooms.get(roomId);
    if (!room || room.state !== 'waiting') return socket.emit('ddz:room-error', '房间不存在或已开始');
    if (room.players.length >= 3) return socket.emit('ddz:room-error', '房间已满');
    ddzLeaveRoom(socket.id);
    const p = profiles.get(socket.id) || {};
    room.players.push({ id: socket.id, name: p.name || 'Player', color: p.color || '#2ecc71', skin: p.skin || 'classic' });
    ddzPlayerRoom.set(socket.id, roomId);
    socket.join(roomId);
    socket.emit('ddz:room-joined', { roomId });
    io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
  });

  socket.on('ddz:add-bot', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length >= 3) return;
    const botIdx = room.players.length;
    const botNames = ['Bot-Alice', 'Bot-Bob', 'Bot-Charlie'];
    room.players.push({ id: 'ai_' + botIdx, name: botNames[botIdx - 1] || 'Bot-' + botIdx, color: '#888', skin: 'classic' });
    io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
  });

  socket.on('ddz:leave-room', () => {
    ddzLeaveRoom(socket.id);
  });

  socket.on('ddz:start-game', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    // Create deck & deal
    const deck = shuffleDeck(createDeck());
    const hands = {};
    room.players.forEach((p, i) => {
      hands[p.id] = sortCards(deck.slice(i * 17, (i + 1) * 17));
    });
    const bottomCards = deck.slice(51, 54);

    // Random landlord
    const landlordIdx = Math.random() * 3 | 0;
    const landlordId = room.players[landlordIdx].id;
    // Give bottom cards to landlord
    hands[landlordId] = sortCards([...hands[landlordId], ...bottomCards]);

    const roles = room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: hands[p.id].length,
      isLandlord: p.id === landlordId,
    }));

    const gameState = {
      roomId,
      phase: 'play',
      roles,
      hands,
      bottomCards,
      landlordId,
      currentPlayer: landlordId,
      lastPlay: null,
      passCount: 0,
      winner: null,
    };
    ddzGameStates.set(roomId, gameState);
    room.state = 'playing';

    // Emit per-player (each sees only their own cards)
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return; // skip AI — no socket to emit to
      io.to(p.id).emit('ddz:game-start', {
        phase: 'play',
        players: roles,
        currentPlayer: landlordId,
        lastPlay: null,
        passCount: 0,
        bottomCards: [],
        winner: null,
        myCards: hands[p.id],
      });
    });

    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));

    // If first player is AI, trigger AI turn
    setTimeout(() => ddzTriggerAI(roomId), 800);
  });

  socket.on('ddz:play-cards', (data) => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const game = ddzGameStates.get(roomId);
    if (!game || game.phase !== 'play') return;
    if (game.currentPlayer !== socket.id) return socket.emit('ddz:room-error', '还没轮到你');
    const room = ddzRooms.get(roomId);
    if (!room) return;

    const cards = data && data.cards;
    if (!cards || !cards.length) return;

    // Verify player has the selected cards
    const hand = game.hands[socket.id];
    if (!hand) return;
    const cardKeys = cards.map(c => `${c.suit}_${c.value}`);
    const handKeys = hand.map(c => `${c.suit}_${c.value}`);
    const handCopy = [...handKeys];
    for (const k of cardKeys) {
      const idx = handCopy.indexOf(k);
      if (idx === -1) return socket.emit('ddz:room-error', '没有这些牌');
      handCopy.splice(idx, 1);
    }

    // Validate play type
    const playType = getCardType(cards);
    if (!playType) return socket.emit('ddz:room-error', '无效的牌型');

    // Check can beat last play
    if (game.lastPlay) {
      if (!canBeat(playType, game.lastPlay)) return socket.emit('ddz:room-error', '打不起');
    }

    // Remove cards from hand
    const newHand = handKeys.filter(k => !cardKeys.includes(k));
    game.hands[socket.id] = newHand.map(k => {
      const [s, v] = k.split('_');
      return { suit: s, value: v };
    });

    // Update state
    game.lastPlay = { playerId: socket.id, cards, type: playType.type, main: playType.main, length: playType.length };
    game.passCount = 0;

    // Update cardCount in roles
    const role = game.roles.find(r => r.id === socket.id);
    if (role) role.cardCount = game.hands[socket.id].length;

    // Check win
    if (game.hands[socket.id].length === 0) {
      game.phase = 'ended';
      const winnerRole = game.roles.find(r => r.id === socket.id);
      game.winner = {
        id: socket.id,
        name: winnerRole ? winnerRole.name : 'Player',
        type: winnerRole && winnerRole.isLandlord ? 'landlord' : 'farmer',
      };
    }

    if (game.phase === 'ended') {
      room.state = 'waiting';
      room.players.forEach(p => {
        if (p.id.startsWith('ai_')) return;
        io.to(p.id).emit('ddz:game-over', {
          phase: 'ended',
          players: game.roles,
          currentPlayer: null,
          lastPlay: game.lastPlay,
          passCount: 0,
          bottomCards: game.bottomCards,
          winner: game.winner,
          myCards: game.hands[p.id] || [],
        });
      });
      ddzGameStates.delete(room.id);
      io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
    } else {
      // Next player's turn
      const idx = game.roles.findIndex(r => r.id === socket.id);
      game.currentPlayer = game.roles[(idx + 1) % 3].id;

      room.players.forEach(p => {
        if (p.id.startsWith('ai_')) return;
        io.to(p.id).emit('ddz:game-state', {
          phase: 'play',
          players: game.roles,
          currentPlayer: game.currentPlayer,
          lastPlay: game.lastPlay,
          passCount: game.passCount,
          bottomCards: [],
          winner: null,
          myCards: game.hands[p.id],
        });
      });

      if (game.currentPlayer.startsWith('ai_')) {
        setTimeout(() => ddzTriggerAI(roomId), 1000);
      }
    }
  });

  socket.on('ddz:pass', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const game = ddzGameStates.get(roomId);
    if (!game || game.phase !== 'play') return;
    if (game.currentPlayer !== socket.id) return socket.emit('ddz:room-error', '还没轮到你');
    // Cannot pass when no lastPlay (must play to start a round)
    if (!game.lastPlay) return socket.emit('ddz:room-error', '必须出牌');
    const room = ddzRooms.get(roomId);
    if (!room) return;

    game.passCount++;

    if (game.passCount >= 2) {
      // Both opponents passed; last player who played starts a new round
      game.currentPlayer = game.lastPlay.playerId;
      game.lastPlay = null;
      game.passCount = 0;
    } else {
      const idx = game.roles.findIndex(r => r.id === socket.id);
      game.currentPlayer = game.roles[(idx + 1) % 3].id;
    }

    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return;
      io.to(p.id).emit('ddz:game-state', {
        phase: 'play',
        players: game.roles,
        currentPlayer: game.currentPlayer,
        lastPlay: game.lastPlay,
        passCount: game.passCount,
        bottomCards: [],
        winner: null,
        myCards: game.hands[p.id],
      });
    });

    if (game.currentPlayer.startsWith('ai_')) {
      setTimeout(() => ddzTriggerAI(roomId), 1000);
    }
  });

  // ── Cleanup on disconnect ──
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    // Snake cleanup
    snakes.delete(socket.id);
    profiles.delete(socket.id);
    io.emit('state', getState());
    if (snakes.size === 0 && gameLoop) {
      clearInterval(gameLoop); gameLoop = null;
      clearInterval(timerIv); timerIv = null;
      state = 'waiting'; remaining = ROUND_DURATION;
    }
    // Doudizhu cleanup
    ddzLeaveRoom(socket.id);
  });
});

// ─── Doudizhu room helpers ────────────────────────────────
let ddzRoomId = 0;
const ddzRooms = new Map();      // roomId -> room
const ddzPlayerRoom = new Map(); // socketId -> roomId
const ddzGameStates = new Map(); // roomId -> gameState

function ddzLeaveRoom(id) {
  const roomId = ddzPlayerRoom.get(id);
  if (!roomId) return;
  const room = ddzRooms.get(roomId);

  // Clean up game state if active game exists
  if (ddzGameStates.has(roomId)) {
    ddzGameStates.delete(room.id);
    if (room) {
      room.players.filter(p => p.id !== id).forEach(p => {
        io.to(p.id).emit('ddz:room-error', '游戏已中断（玩家退出）');
      });
    }
  }

  if (room) {
    room.players = room.players.filter(p => p.id !== id);
    if (room.players.length === 0) {
      ddzRooms.delete(roomId);
    } else {
      if (room.hostId === id) room.hostId = room.players[0].id;
      io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    }
  }
  ddzPlayerRoom.delete(id);
}

// ─── Doudizhu Card Logic ────────────────────────────────────
const VALUE_ORDER = {
  '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7,
  '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12, '2': 13, 'small': 14, 'big': 15,
};
const SUITS = ['spade', 'heart', 'club', 'diamond'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of ['3','4','5','6','7','8','9','10','J','Q','K','A','2']) {
      deck.push({ suit, value });
    }
  }
  deck.push({ suit: 'joker', value: 'small' });
  deck.push({ suit: 'joker', value: 'big' });
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    const vo = VALUE_ORDER[b.value] - VALUE_ORDER[a.value];
    if (vo !== 0) return vo;
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

function getCardType(cards) {
  const n = cards.length;
  if (n === 0) return null;

  // Sort by value order
  const sorted = [...cards].sort((a, b) => VALUE_ORDER[a.value] - VALUE_ORDER[b.value]);

  // Count values
  const vc = {};
  for (const c of sorted) vc[c.value] = (vc[c.value] || 0) + 1;
  const vals = Object.keys(vc);

  // Rocket (both jokers)
  if (n === 2 && vals.includes('small') && vals.includes('big')) {
    return { type: 'rocket', main: 'big', length: 2 };
  }

  // Single
  if (n === 1) return { type: 'single', main: sorted[0].value, length: 1 };

  // Pair
  if (n === 2 && Object.values(vc).every(c => c === 2)) {
    return { type: 'pair', main: vals[0], length: 2 };
  }

  // Triple
  if (n === 3 && Object.values(vc).every(c => c === 3)) {
    return { type: 'triple', main: vals[0], length: 3 };
  }

  // Bomb
  if (n === 4 && Object.values(vc).every(c => c === 4)) {
    return { type: 'bomb', main: vals[0], length: 4 };
  }

  // Triple + one
  if (n === 4) {
    const counts = Object.values(vc);
    const triVal = vals.find(v => vc[v] === 3);
    if (triVal && counts.includes(1)) {
      return { type: 'triple_one', main: triVal, length: 4 };
    }
  }

  // Triple + pair
  if (n === 5) {
    const triVal = vals.find(v => vc[v] === 3);
    const paiVal = vals.find(v => vc[v] === 2);
    if (triVal && paiVal) {
      return { type: 'triple_pair', main: triVal, length: 5 };
    }
  }

  // Four + two singles
  if (n === 6) {
    const fourVal = vals.find(v => vc[v] === 4);
    if (fourVal) {
      const remaining = vals.filter(v => v !== fourVal);
      if (remaining.length === 2 && remaining.every(v => vc[v] === 1)) {
        return { type: 'four_two', main: fourVal, length: 6 };
      }
    }
  }

  // Four + two pairs
  if (n === 8) {
    const fourVal = vals.find(v => vc[v] === 4);
    if (fourVal) {
      const remaining = vals.filter(v => v !== fourVal);
      if (remaining.length === 2 && remaining.every(v => vc[v] === 2)) {
        return { type: 'four_two_pair', main: fourVal, length: 8 };
      }
    }
  }

  // Straight: 5+ consecutive singles, 3-A only
  if (n >= 5 && Object.values(vc).every(c => c === 1)) {
    const sv = vals.sort((a, b) => VALUE_ORDER[a] - VALUE_ORDER[b]);
    if (sv.every(v => VALUE_ORDER[v] <= VALUE_ORDER['A'])) {
      const consec = sv.every((v, i) => i === 0 || VALUE_ORDER[v] - VALUE_ORDER[sv[i - 1]] === 1);
      if (consec) return { type: 'straight', main: sv[sv.length - 1], length: n };
    }
  }

  // Double straight: 3+ consecutive pairs, 3-A only
  if (n >= 6 && n % 2 === 0) {
    const pairVals = vals.filter(v => vc[v] === 2);
    if (pairVals.length >= 3 && pairVals.length === n / 2) {
      const sp = pairVals.sort((a, b) => VALUE_ORDER[a] - VALUE_ORDER[b]);
      if (sp.every(v => VALUE_ORDER[v] <= VALUE_ORDER['A'])) {
        const consec = sp.every((v, i) => i === 0 || VALUE_ORDER[v] - VALUE_ORDER[sp[i - 1]] === 1);
        if (consec) return { type: 'double_straight', main: sp[sp.length - 1], length: n };
      }
    }
  }

  // Plane detection
  if (n >= 6) {
    const triVals = vals.filter(v => vc[v] === 3);
    if (triVals.length >= 2) {
      const st = triVals.sort((a, b) => VALUE_ORDER[a] - VALUE_ORDER[b]);
      // Check all subsets of consecutive triples
      for (let start = 0; start < st.length; start++) {
        for (let len = 2; len <= st.length - start; len++) {
          const seq = st.slice(start, start + len);
          const consec = seq.every((v, i) => i === 0 || VALUE_ORDER[v] - VALUE_ORDER[seq[i - 1]] === 1);
          if (!consec) break;
          if (seq.some(v => VALUE_ORDER[v] > VALUE_ORDER['A'])) continue;

          const baseCards = len * 3;
          const remaining = n - baseCards;

          if (remaining === 0) return { type: 'plane', main: seq[seq.length - 1], length: n };

          // Plane + singles (one single per triple)
          if (remaining === len) {
            const rest = vals.filter(v => !seq.includes(v));
            if (rest.every(v => vc[v] === 1)) {
              return { type: 'plane_single', main: seq[seq.length - 1], length: n };
            }
          }

          // Plane + pairs (one pair per triple)
          if (remaining === len * 2) {
            const rest = vals.filter(v => !seq.includes(v));
            if (rest.length === len && rest.every(v => vc[v] === 2)) {
              return { type: 'plane_pair', main: seq[seq.length - 1], length: n };
            }
          }
        }
      }
    }
  }

  return null;
}

function canBeat(play, lastPlay) {
  // Rocket beats everything
  if (play.type === 'rocket') return true;
  if (lastPlay.type === 'rocket') return false;

  // Bomb beats non-bomb
  if (play.type === 'bomb' && lastPlay.type !== 'bomb') return true;
  if (lastPlay.type === 'bomb' && play.type !== 'bomb') return false;

  // Both bombs: higher main wins
  if (play.type === 'bomb' && lastPlay.type === 'bomb') {
    return VALUE_ORDER[play.main] > VALUE_ORDER[lastPlay.main];
  }

  // Same type & same length: higher main wins
  if (play.type === lastPlay.type && play.length === lastPlay.length) {
    return VALUE_ORDER[play.main] > VALUE_ORDER[lastPlay.main];
  }

  return false;
}

// ─── AI Players ────────────────────────────────────────────
function ddzTriggerAI(roomId) {
  const game = ddzGameStates.get(roomId);
  if (!game || game.phase !== 'play') return;
  if (!game.currentPlayer.startsWith('ai_')) return;
  const room = ddzRooms.get(roomId);
  if (!room) return;
  ddzAIPlay(game, room);
}

function ddzAIPlay(game, room) {
  try {
    const aiId = game.currentPlayer;
    const hand = game.hands[aiId];
    if (!hand || hand.length === 0) return;

    // Group cards by value
    const groups = {};
    for (const c of hand) {
      if (!groups[c.value]) groups[c.value] = [];
      groups[c.value].push(c);
    }
    const sortedVals = Object.keys(groups).sort((a, b) => VALUE_ORDER[a] - VALUE_ORDER[b]);

    let chosen = null;

    if (!game.lastPlay) {
      // Lead: always play lowest single
      const lowestVal = sortedVals[0];
      chosen = [groups[lowestVal][0]];
    } else {
      const last = game.lastPlay;

      if (last.type === 'single') {
        // Try to play a higher single (non-joker first)
        const mainOrder = VALUE_ORDER[last.main] || 0;
        for (const v of sortedVals) {
          if (v !== 'small' && v !== 'big' && VALUE_ORDER[v] > mainOrder) {
            chosen = [groups[v][0]];
            break;
          }
        }
      } else if (last.type === 'pair') {
        const mainOrder = VALUE_ORDER[last.main] || 0;
        for (const v of sortedVals) {
          if (groups[v].length >= 2 && VALUE_ORDER[v] > mainOrder) {
            chosen = groups[v].slice(0, 2);
            break;
          }
        }
      }

      // Try bomb
      if (!chosen) {
        for (const v of sortedVals) {
          if (groups[v].length === 4) { chosen = groups[v]; break; }
        }
      }

      // Try rocket
      if (!chosen && groups['small'] && groups['big']) {
        chosen = [...groups['small'], ...groups['big']];
      }

      // Pass
      if (!chosen) {
        game.passCount++;
        if (game.passCount >= 2) {
          game.currentPlayer = game.lastPlay.playerId;
          game.lastPlay = null;
          game.passCount = 0;
        } else {
          const idx = game.roles.findIndex(r => r.id === aiId);
          game.currentPlayer = game.roles[(idx + 1) % 3].id;
        }
        room.players.forEach(p => {
          if (p.id.startsWith('ai_')) return;
          io.to(p.id).emit('ddz:game-state', {
            phase: 'play', players: game.roles, currentPlayer: game.currentPlayer,
            lastPlay: game.lastPlay, passCount: game.passCount, bottomCards: [], winner: null,
            myCards: game.hands[p.id],
          });
        });
        if (game.currentPlayer.startsWith('ai_')) setTimeout(() => ddzTriggerAI(room.id), 1000);
        return;
      }
    }

    // Play chosen cards
    const chosenKeys = new Set(chosen.map(c => `${c.suit}_${c.value}`));
    game.hands[aiId] = hand.filter(c => !chosenKeys.has(`${c.suit}_${c.value}`));

    const playType = getCardType(chosen);
  game.lastPlay = { playerId: aiId, cards: chosen, type: playType.type, main: playType.main, length: playType.length };
  game.passCount = 0;

  const role = game.roles.find(r => r.id === aiId);
  if (role) role.cardCount = game.hands[aiId].length;

  // Check win
  if (game.hands[aiId].length === 0) {
    game.phase = 'ended';
    game.winner = { id: aiId, name: role ? role.name : 'Bot', type: role && role.isLandlord ? 'landlord' : 'farmer' };
    room.state = 'waiting';
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return;
      io.to(p.id).emit('ddz:game-over', {
        phase: 'ended', players: game.roles, currentPlayer: null, lastPlay: game.lastPlay, passCount: 0,
        bottomCards: game.bottomCards, winner: game.winner, myCards: game.hands[p.id] || [],
      });
    });
    ddzGameStates.delete(room.id);
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
    return;
  }

  const idx = game.roles.findIndex(r => r.id === aiId);
  game.currentPlayer = game.roles[(idx + 1) % 3].id;

  room.players.forEach(p => {
    if (p.id.startsWith('ai_')) return;
    io.to(p.id).emit('ddz:game-state', {
      phase: 'play', players: game.roles, currentPlayer: game.currentPlayer,
      lastPlay: game.lastPlay, passCount: game.passCount, bottomCards: [], winner: null,
      myCards: game.hands[p.id],
    });
  });

  if (game.currentPlayer.startsWith('ai_')) {
    setTimeout(() => ddzTriggerAI(room.id), 1000);
  }
} catch (e) {
  console.error('[ddzAI]', e);
}
}

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  const os = require('os');
  let ip = 'localhost';
  for (const name of Object.keys(os.networkInterfaces()))
    for (const iface of os.networkInterfaces()[name] || [])
      if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
  console.log(`\n  🐍 Snake Battle`);
  console.log(`  ─────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  LAN:     http://${ip}:${PORT}`);
  console.log(`  Ready!\n`);
});
