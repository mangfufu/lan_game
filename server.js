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

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    snakes.delete(socket.id);
    profiles.delete(socket.id);
    io.emit('state', getState());
    if (snakes.size === 0 && gameLoop) {
      clearInterval(gameLoop); gameLoop = null;
      clearInterval(timerIv); timerIv = null;
      state = 'waiting'; remaining = ROUND_DURATION;
    }
  });
});

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
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
