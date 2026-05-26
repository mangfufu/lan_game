const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });
app.use(express.static('public', { maxAge: 0, etag: false }));

// ─── Config ────────────────────────────────────────────────
const COLS = 70, ROWS = 70, TICK_MS = 90;
const FOOD_COUNT = 50, RESPAWN_DELAY = 2000;
const ROUND_DURATION = 5 * 60 * 1000; // 5 min
const SPRINT_COOLDOWN = 3000, MIN_SPRINT_LENGTH = 3, SPRINT_POP = 1;

const POWERUP_TYPES = [
    { type: 'gold', color: '#FFD700', label: '金', effect: 'score3', desc: '+3分 +3节' },
    { type: 'shield', color: '#00BFFF', label: '盾', effect: 'shield', desc: '护盾5秒' },
    { type: 'rainbow', color: '#FF69B4', label: '炫', effect: 'confuse', desc: '迷惑对手3秒' },
    { type: 'magnet', color: '#FFD700', label: '吸', effect: 'magnet', desc: '磁铁: 吸引周围3格食物' },
    { type: 'freeze', color: '#87CEEB', label: '冰', effect: 'freeze', desc: '冻结: 冻结所有对手2秒' },
    { type: 'warp', color: '#9932CC', label: '瞬', effect: 'warp', desc: '瞬移: 传送至随机位置' },
];
const POWERUP_INTERVAL = 150; // ticks between spawns (~20s)
const MAX_POWERUPS = 3;

const COLORS = [
  '#e74c3c','#2ecc71','#3498db','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#ff6b81','#00d2d3','#95e600','#e056fd','#54a0ff',
];

const FLAVOR_MESSAGES = [
  '🐍 {name} 滑得像条泥鳅！',
  '💀 {name} 把自己缠死了',
  '🔥 {name} 正在疯狂冲刺！',
  '🍎 {name} 吃了个饱',
  '⚡ {name} 快如闪电！',
  '🏆 {name} 是全场最长的蛇！',
  '😱 {name} 差点撞墙！',
  '🚀 {name} 起飞了！',
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
let currentFlavorText = '';
let flavorTextTimer = 0;
let lastLongestId = null;
const powerups = new Map();  // cellKey -> {x, y, type, color, effect}
let powerupTick = 0;        // countdown to next spawn

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
  const now = Date.now();
  // Only count normal food — death food is temporary
  const normalCount = [...food.values()].filter(f => f.type !== 'death').length;
  for (let i = normalCount; i < FOOD_COUNT; i++) {
    const c = randCell();
    if (!c) break;
    food.set(ck(c.x, c.y), { x: c.x, y: c.y, color: COLORS[Math.random() * COLORS.length | 0], type: 'normal', createdAt: now });
  }
}

function setFlavorText(text) {
    currentFlavorText = text;
    flavorTextTimer = 30;
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
  return { id, body, dir, nextDir: dir, alive: true, score: 0, sprintTick: 0, color: p.color || '#2ecc71', skin: p.skin || 'classic', name: p.name || 'Player', sprinting: false, lastSprintTime: 0, shieldTimer: 0, confuseTimer: 0, frozenTimer: 0, magnetTimer: 0 };
}

function nearSnake(x, y, d) {
  for (const s of snakes.values()) if (s.alive) for (const g of s.body) if (Math.abs(g.x - x) + Math.abs(g.y - y) < d) return true;
  return false;
}

function randCellPowerup() {
    const occ = new Set();
    for (const s of snakes.values()) if (s.alive) for (const g of s.body) occ.add(ck(g.x, g.y));
    for (const k of food.keys()) occ.add(k);
    for (const k of powerups.keys()) occ.add(k);
    const free = [];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!occ.has(ck(x, y))) free.push({ x, y });
    return free.length ? free[Math.random() * free.length | 0] : null;
}

function getState() {
  let longestSnake = null, maxLen = 0;
  for (const s of snakes.values()) {
    if (s.alive && s.body.length > maxLen) { maxLen = s.body.length; longestSnake = { id: s.id, name: s.name, length: s.body.length }; }
  }
  if (longestSnake && longestSnake.id !== lastLongestId) {
    lastLongestId = longestSnake.id;
    setFlavorText('🏆 ' + longestSnake.name + ' 成为最长蛇！');
  }
  return {
    snakes: [...snakes.values()].map(s => ({ id: s.id, body: s.body, color: s.color, skin: s.skin, alive: s.alive, score: s.score, name: s.name, length: s.body.length, shieldActive: s.shieldTimer > 0, confused: s.confuseTimer > 0, frozen: s.frozenTimer > 0, magnetActive: s.magnetTimer > 0 })),
    food: [...food.values()],
    powerups: [...powerups.values()].map(p => ({ x: p.x, y: p.y, type: p.type, color: p.color, effect: p.effect })),
    cols: COLS, rows: ROWS,
    state, remaining,
    longestSnake,
    flavorText: currentFlavorText,
  };
}

// ─── Game lifecycle ────────────────────────────────────────
function startGame() {
  if (state === 'playing') return;
  state = 'playing'; remaining = ROUND_DURATION; startAt = Date.now();
  food.clear();
  // Clean up old snake bots
  for (const id of [...snakes.keys()]) {
    if (id.startsWith('ai_snake_')) { snakes.delete(id); profiles.delete(id); }
  }
  powerups.clear();
  powerupTick = 0;
  lastLongestId = null;
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
  for (const s of snakes.values()) {
    if (s.shieldTimer > 0) s.shieldTimer--;
    if (s.confuseTimer > 0) s.confuseTimer--;
    if (s.frozenTimer > 0) s.frozenTimer--;
    if (s.magnetTimer > 0) s.magnetTimer--;
  }

  // Normal move
  for (const s of snakes.values()) {
    if (!s.alive || s.frozenTimer > 0) continue;
    s.dir = s.nextDir;
    const h = move(s);
    foodCheck(s, h);
    if (deathCheck(s, h)) { deaths.push(s); continue; }
  }

  // Sprint move
  for (const s of snakes.values()) {
    if (!s.alive || s.frozenTimer > 0 || !s.sprinting || s.body.length <= MIN_SPRINT_LENGTH) continue;
    s.sprintTick++;
    if (s.sprintTick % 3 === 0 && s.score > 0) s.score--;
    const h = move(s);
    foodCheck(s, h);
    if (deathCheck(s, h)) { if (!deaths.includes(s)) deaths.push(s); continue; }
    // Pop multiple segments — sprint costs body length
    for (let i = 0; i < SPRINT_POP && s.body.length > 3; i++) {
      s.body.pop();
    }
    if (s.body.length <= 3) { s.sprinting = false; s.lastSprintTime = Date.now(); s.sprintTick = 0; }
  }

  // Snake-snake collision
  for (const s of snakes.values()) {
    if (!s.alive || deaths.includes(s)) continue;
    const h = s.body[0];
    for (const o of snakes.values()) {
      if (o === s || !o.alive) continue;
      for (let i = 0; i < o.body.length; i++)
        if (h.x === o.body[i].x && h.y === o.body[i].y) {
          if (s.shieldTimer > 0) { s.shieldTimer = 0; break; }
          s.alive = false; deaths.push(s); break;
        }
      if (!s.alive) break;
    }
  }

  // Powerup check
  for (const s of snakes.values()) {
    if (!s.alive) continue;
    const h = s.body[0];
    const k = ck(h.x, h.y);
    if (powerups.has(k)) {
      const pu = powerups.get(k);
      powerups.delete(k);
      if (pu.effect === 'score3') {
        s.score += 3;
        for (let i = 0; i < 3; i++) s.body.push({ ...s.body[s.body.length - 1] });
        setFlavorText('⭐ ' + s.name + ' 吃了金食物！+3分！');
      } else if (pu.effect === 'shield') {
        s.shieldTimer = Math.round(5000 / TICK_MS);
        setFlavorText('🛡️ ' + s.name + ' 获得护盾！');
      } else if (pu.effect === 'confuse') {
        for (const o of snakes.values()) {
          if (o.id !== s.id && o.alive) o.confuseTimer = Math.round(3000 / TICK_MS);
        }
        setFlavorText('🌈 ' + s.name + ' 释放了迷惑波！');
      } else if (pu.effect === 'magnet') {
        s.magnetTimer = Math.round(5000 / TICK_MS); // 5 seconds of magnet
        setFlavorText('🧲 ' + s.name + ' 获得了磁铁能力！');
      } else if (pu.effect === 'freeze') {
        for (const o of snakes.values()) {
          if (o.id !== s.id && o.alive) o.frozenTimer = Math.round(2000 / TICK_MS);
        }
        setFlavorText('❄️ ' + s.name + ' 释放了冰冻！');
      } else if (pu.effect === 'warp') {
        const occ = new Set();
        for (const os of snakes.values()) if (os.alive) for (const g of os.body) occ.add(ck(g.x, g.y));
        for (const k of food.keys()) occ.add(k);
        for (const k of powerups.keys()) occ.add(k);
        const free = [];
        for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!occ.has(ck(x, y))) free.push({ x, y });
        if (free.length > 0) {
          const target = free[Math.random() * free.length | 0];
          s.body[0] = target;
        }
        setFlavorText('🌀 ' + s.name + ' 瞬移了！');
      }
    }
  }

  // Death → food (capped at FOOD_COUNT * 2)
  for (const s of deaths) {
    s.score = Math.floor(s.score * 0.8); // lose 20%
    io.emit('player-died', { id: s.id, name: s.name, score: s.score });
    const foodCount = Math.max(1, Math.floor(s.body.length * 0.6));
    const shuffled = [...s.body].sort(() => Math.random() - 0.5);
    const now = Date.now();
    for (let i = 0; i < foodCount; i++) {
      const g = shuffled[i];
      const k = ck(g.x, g.y);
      if (!food.has(k)) food.set(k, { x: g.x, y: g.y, color: s.color, type: 'death', createdAt: now });
    }
  }
  if (deaths.length > 0) {
    const lastDead = deaths[deaths.length - 1];
    setFlavorText('💀 ' + lastDead.name + ' 阵亡了！');
  }
  // Cap total food: prefer removing death food
  while (food.size > FOOD_COUNT * 2) {
    const deathKeys = [...food.keys()].filter(k => food.get(k).type === 'death');
    if (deathKeys.length > 0) {
      food.delete(deathKeys[Math.random() * deathKeys.length | 0]);
    } else {
      const keys = [...food.keys()];
      food.delete(keys[Math.random() * keys.length | 0]);
    }
  }

  // Expire death food after 5 seconds
  const expireTime = 5000;
  const now = Date.now();
  for (const [k, f] of food) {
    if (f.type === 'death' && now - f.createdAt > expireTime) {
      food.delete(k);
    }
  }

  // Spawn powerups
  if (powerupTick <= 0 && powerups.size < MAX_POWERUPS) {
    const freeCell = randCellPowerup();
    if (freeCell) {
      const pt = POWERUP_TYPES[Math.random() * POWERUP_TYPES.length | 0];
      powerups.set(ck(freeCell.x, freeCell.y), { x: freeCell.x, y: freeCell.y, type: pt.type, color: pt.color, label: pt.label, effect: pt.effect, desc: pt.desc });
    }
    powerupTick = POWERUP_INTERVAL;
  } else {
    powerupTick--;
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

  // Flavor text countdown
  if (flavorTextTimer > 0) {
    flavorTextTimer--;
    if (flavorTextTimer === 0) currentFlavorText = '';
  }

  // Magnet effect: eat nearby food
  for (const s of snakes.values()) {
    if (!s.alive || s.magnetTimer <= 0) continue;
    const head = s.body[0];
    for (const [fk, f] of food) {
      const dist = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
      if (dist <= 3) {
        food.delete(fk);
        s.score++;
        const tail = s.body[s.body.length - 1];
        s.body.push({ ...tail });
        spawnFood();
      }
    }
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
  if (food.has(k)) {
    food.delete(k);
    s.score++;
    spawnFood();
    // body stays +1 from move() — no net pop
  } else {
    s.body.pop();
  }
}

function deathCheck(s, h) {
  if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS) {
    if (s.shieldTimer > 0) { s.shieldTimer = 0; return false; }
    s.alive = false; return true;
  }
  for (let i = 1; i < s.body.length; i++) if (s.body[i].x === h.x && s.body[i].y === h.y) {
    if (s.shieldTimer > 0) { s.shieldTimer = 0; return false; }
    s.alive = false; return true;
  }
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
    if (state === 'waiting') startGame();
    else if (state === 'playing') io.emit('state', getState());
    snakeAutoFill();
  });

  socket.on('set-name', (name) => {
    const p = profiles.get(socket.id);
    if (p) p.name = (name || 'Player').substring(0, 16);
  });

  socket.on('dir', (dir) => {
    const s = snakes.get(socket.id); if (!s || !s.alive) return;
    const opp = { up:'down', down:'up', left:'right', right:'left' };
    if (s.confuseTimer > 0) dir = opp[dir] || dir; // reversed!
    if (dir !== opp[s.dir]) s.nextDir = dir;
  });

  socket.on('sprint', (active) => {
    const s = snakes.get(socket.id); if (!s || !s.alive) return;
    if (active) {
      if (s.body.length <= MIN_SPRINT_LENGTH) return;
      if (Date.now() - s.lastSprintTime < SPRINT_COOLDOWN) return;
      s.sprinting = true;
      setFlavorText('⚡ ' + s.name + ' 开始冲刺！');
    } else {
      s.sprinting = false;
      s.lastSprintTime = Date.now();
    }
  });

  // ── Snake bots ──
  function snakeAddBot() {
    const botColors = ['#e74c3c','#3498db','#f39c12','#9b59b6','#1abc9c'];
    const botNames = ['Bot-蛇仔', 'Bot-贪吃鬼', 'Bot-闪电侠', 'Bot-小旋风', 'Bot-长蛇君'];
    const botCount = [...snakes.keys()].filter(id => id.startsWith('ai_snake_')).length;
    if (snakes.size >= 5) return;
    const botId = 'ai_snake_' + botCount;
    const p = { name: botNames[botCount % botNames.length], color: botColors[botCount % botColors.length], skin: 'classic' };
    profiles.set(botId, p);
    snakes.set(botId, makeSnake(botId));
    // Bot AI: seek food, avoid walls and other snakes
    const botInterval = setInterval(() => {
      const s = snakes.get(botId);
      if (!s || !s.alive) return; // skip if dead; interval lives on for respawn
      const dirs = ['up','down','left','right'];
      const opp = { up:'down', down:'up', left:'right', right:'left' };
      const delta = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
      // Find nearest food
      let nearestFood = null, minDist = Infinity;
      const head = s.body[0];
      for (const f of food.values()) {
        const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
        if (d < minDist) { minDist = d; nearestFood = f; }
      }
      // Score each direction: safe + distance to food
      const scored = dirs.map(d => {
        if (d === opp[s.dir]) return { dir: d, score: -999 };
        const nx = head.x + delta[d][0];
        const ny = head.y + delta[d][1];
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return { dir: d, score: -999 }; // wall
        // Check collision with any snake body
        for (const os of snakes.values()) {
          if (!os.alive) continue;
          for (let i = 0; i < os.body.length; i++) {
            if (os.body[i].x === nx && os.body[i].y === ny) return { dir: d, score: -999 };
          }
        }
        // Award points for getting closer to food
        let score = 0;
        if (nearestFood) {
          const afterDist = Math.abs(nearestFood.x - nx) + Math.abs(nearestFood.y - ny);
          score = minDist - afterDist; // positive = closer
        }
        // Bonus for continuing same direction (smoothness)
        if (d === s.dir) score += 0.5;
        // Bonus for powerups
        for (const pu of powerups.values()) {
          const puDist = Math.abs(pu.x - nx) + Math.abs(pu.y - ny);
          if (puDist < 3) score += 1;
        }
        return { dir: d, score };
      });
      // Pick best direction; if none safe, keep going
      const best = scored.filter(s => s.score > -999).sort((a, b) => b.score - a.score);
      s.nextDir = best.length > 0 ? best[0].dir : s.dir;
      // Sprint logic: use sprint when food is far and body is long enough
      if (!s.sprinting && s.body.length > 6 && nearestFood && minDist > 15) {
        s.sprinting = true;
        setFlavorText('🤖 ' + s.name + ' 开始冲刺！');
      }
      if (s.sprinting && (s.body.length <= 4 || (nearestFood && minDist <= 5))) {
        s.sprinting = false;
      }
    }, 200);
    if (state === 'waiting') startGame();
    else io.emit('state', getState());
  }

  function snakeAutoFill() {
    const humanCount = [...snakes.keys()].filter(id => !id.startsWith('ai_snake_')).length;
    if (humanCount === 0) return;
    // Enough humans — remove all bots
    if (humanCount >= 5) {
      for (const id of [...snakes.keys()]) {
        if (id.startsWith('ai_snake_')) { snakes.delete(id); profiles.delete(id); }
      }
      io.emit('state', getState());
      return;
    }
    // Fill with bots up to 5 total
    while (snakes.size < 5) snakeAddBot();
  }

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
    // Update profile from DDZ create data
    const p = profiles.get(socket.id) || {};
    if (data && data.playerName) p.name = data.playerName.substring(0, 16);
    if (data && data.color) p.color = data.color;
    if (data && data.skin) p.skin = data.skin;
    room.players.push({ id: socket.id, name: p.name || 'Player', color: getDistinctColor(room, p.color || '#2ecc71'), skin: p.skin || 'classic' });
    ddzRooms.set(id, room);
    ddzPlayerRoom.set(socket.id, id);
    socket.emit('ddz:room-joined', { roomId: id });
    socket.join(id);
    // Auto-dismiss after 3 minutes if no game starts
    const timer = setTimeout(() => ddzDismissRoom(id), 3 * 60 * 1000);
    ddzRoomTimers.set(id, timer);
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
    io.to(id).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
  });

  socket.on('ddz:join-room', (roomId) => {
    const room = ddzRooms.get(roomId);
    if (!room || room.state !== 'waiting') return socket.emit('ddz:room-error', '房间不存在或已开始');
    if (room.players.length >= 3) return socket.emit('ddz:room-error', '房间已满');
    ddzLeaveRoom(socket.id);
    const p = profiles.get(socket.id) || {};
    room.players.push({ id: socket.id, name: p.name || 'Player', color: getDistinctColor(room, p.color || '#2ecc71'), skin: p.skin || 'classic' });
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
    room.players.push({ id: 'ai_' + botIdx, name: botNames[botIdx - 1] || 'Bot-' + botIdx, color: getDistinctColor(room, '#888'), skin: 'classic' });
    io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
  });

  socket.on('ddz:leave-room', () => {
    ddzLeaveRoom(socket.id);
  });

  socket.on('ddz:dismiss-room', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    ddzDismissRoom(roomId);
  });

  socket.on('ddz:kick-player', (data) => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const targetId = data && data.playerId;
    if (!targetId || targetId === socket.id) return;
    room.players = room.players.filter(p => p.id !== targetId);
    ddzPlayerRoom.delete(targetId);
    if (!targetId.startsWith('ai_')) {
      io.to(targetId).emit('ddz:room-dismissed');
    }
    io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
  });

  socket.on('ddz:get-room', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room) return;
    socket.emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
  });

  socket.on('ddz:back-to-room', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    io.to(roomId).emit('ddz:return-to-room');
  });

  socket.on('ddz:start-game', () => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const room = ddzRooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    // Cancel auto-dismiss timer
    if (ddzRoomTimers.has(roomId)) { clearTimeout(ddzRoomTimers.get(roomId)); ddzRoomTimers.delete(roomId); }

    // Create deck & deal (17 cards each, 3 bottom)
    const deck = shuffleDeck(createDeck());
    const hands = {};
    room.players.forEach((p, i) => {
      hands[p.id] = sortCards(deck.slice(i * 17, (i + 1) * 17));
    });
    const bottomCards = deck.slice(51, 54);

    const roles = room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: 17,
      isLandlord: false,
    }));

    const gameState = {
      roomId,
      phase: 'bidding',
      roles,
      hands,
      bottomCards,
      landlordId: null,
      currentBidder: room.players[0].id,
      currentBid: 0,
      bids: [],
      bidCount: 0,
      winner: null,
      lastPlay: null,
      passCount: 0,
      autoPlay: {},
      playerMoves: {},
    };
    ddzGameStates.set(roomId, gameState);
    room.state = 'playing';

    // Emit per-player (each sees only their own 17 cards)
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return; // skip AI — no socket to emit to
      io.to(p.id).emit('ddz:game-start', {
        phase: 'bidding',
        players: roles,
        myCards: hands[p.id],
        bottomCards: bottomCards,
        currentBidder: gameState.currentBidder,
        currentBid: 0,
        bids: [],
        winner: null,
        playerMoves: gameState.playerMoves || {},
      });
    });

    io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));

    // If first bidder is AI, trigger AI bid
    if (gameState.currentBidder.startsWith('ai_')) {
      setTimeout(() => ddzTriggerAIBid(roomId), 800);
    }
  });

  // ── Bidding ────────────────────────────────────────────────
  socket.on('ddz:bid', (data) => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const game = ddzGameStates.get(roomId);
    if (!game || game.phase !== 'bidding') return;
    if (game.currentBidder !== socket.id) return socket.emit('ddz:room-error', '还没轮到你');

    const bid = data.bid; // 0=不叫, 1=叫地主, 2/3=抢地主
    if (bid !== 0 && bid !== 1 && bid !== 2 && bid !== 3) return;
    if (bid > 0 && bid <= game.currentBid) return; // must outbid current highest

    const room = ddzRooms.get(roomId);
    if (!room) return;

    // Record bid
    game.bids.push({ playerId: socket.id, bid });
    game.bidCount++;
    if (bid > game.currentBid) {
      game.currentBid = bid;
    }

    if (game.bidCount >= 3) {
      // All 3 players have bid, determine result
      finishDDZBidding(roomId, game, room);
    } else {
      // Next bidder
      const idx = room.players.findIndex(p => p.id === socket.id);
      game.currentBidder = room.players[(idx + 1) % 3].id;

      // Broadcast bid-phase to all human players
      room.players.forEach(p => {
        if (p.id.startsWith('ai_')) return;
        io.to(p.id).emit('ddz:bid-phase', {
          phase: 'bidding',
          currentBidder: game.currentBidder,
          currentBid: game.currentBid,
          bids: game.bids,
          players: game.roles,
          myCards: game.hands[p.id],
          bottomCards: game.bottomCards,
          winner: null,
          playerMoves: game.playerMoves,
        });
      });

      // Trigger AI if next is AI
      if (game.currentBidder.startsWith('ai_')) {
        setTimeout(() => ddzTriggerAIBid(roomId), 800);
      }
    }
  });

  socket.on('ddz:play-cards', (data) => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const game = ddzGameStates.get(roomId);
    if (!game || game.phase !== 'play') return;
    if (game.currentPlayer !== socket.id) return socket.emit('ddz:room-error', '还没轮到你');
    const room = ddzRooms.get(roomId);
    if (!room) return;
    ddzClearTurnTimer(roomId);

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
    game.playerMoves[socket.id] = { cards, type: playType.type };
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
          playerMoves: game.playerMoves,
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
          bottomCards: game.bottomCards,
          winner: null,
          myCards: game.hands[p.id],
          playerMoves: game.playerMoves,
        });
      });

      if (game.currentPlayer.startsWith('ai_')) {
        setTimeout(() => ddzTriggerAI(roomId), 1000);
      } else {
        ddzStartTurnTimer(roomId);
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
    ddzClearTurnTimer(roomId);

    game.passCount++;
    game.playerMoves[socket.id] = { cards: [], type: 'pass' };

    if (game.passCount >= 2) {
      // Both opponents passed; last player who played starts a new round
      game.currentPlayer = game.lastPlay.playerId;
      game.lastPlay = null;
      game.passCount = 0;
      game.playerMoves = {};
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
        bottomCards: game.bottomCards,
        winner: null,
        myCards: game.hands[p.id],
        playerMoves: game.playerMoves,
      });
    });

    if (game.currentPlayer.startsWith('ai_')) {
      setTimeout(() => ddzTriggerAI(roomId), 1000);
    } else {
      ddzStartTurnTimer(roomId);
    }
  });

  // ── Auto-play toggle ──
  socket.on('ddz:auto-play', (data) => {
    const roomId = ddzPlayerRoom.get(socket.id);
    if (!roomId) return;
    const game = ddzGameStates.get(roomId);
    if (!game) return;
    game.autoPlay = game.autoPlay || {};
    game.autoPlay[socket.id] = !!data.active;

    // If enabling auto-play and it's this player's turn, trigger immediately
    if (data.active && game.phase === 'play' && game.currentPlayer === socket.id) {
      ddzClearTurnTimer(roomId);
      ddzTriggerAIPlay(roomId);
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
    // Auto-fill bots if humans still playing
    if (state === 'playing' || state === 'waiting') setTimeout(snakeAutoFill, 500);
    // Doudizhu cleanup
    ddzLeaveRoom(socket.id);
  });
});

// ─── Doudizhu room helpers ────────────────────────────────
const DDZ_COLORS = ['#e74c3c','#3498db','#f39c12','#2ecc71','#9b59b6','#1abc9c'];
function getDistinctColor(room, preferred) {
  const used = new Set(room.players.map(p => p.color));
  if (preferred && !used.has(preferred)) return preferred;
  for (const c of DDZ_COLORS) { if (!used.has(c)) return c; }
  return DDZ_COLORS[room.players.length % DDZ_COLORS.length];
}
let ddzRoomId = 0;
const ddzRooms = new Map();      // roomId -> room
const ddzPlayerRoom = new Map(); // socketId -> roomId
const ddzGameStates = new Map(); // roomId -> gameState
const ddzRoomTimers = new Map(); // roomId -> setTimeout for auto-dismiss
const ddzTurnTimers = new Map(); // roomId -> setTimeout id for turn timeout
const TURN_TIMEOUT = 25000; // 25 seconds

function ddzDismissRoom(roomId) {
  ddzClearTurnTimer(roomId);
  const room = ddzRooms.get(roomId);
  if (!room) return;
  if (ddzRoomTimers.has(roomId)) { clearTimeout(ddzRoomTimers.get(roomId)); ddzRoomTimers.delete(roomId); }
  io.to(roomId).emit('ddz:room-dismissed');
  if (ddzGameStates.has(roomId)) ddzGameStates.delete(roomId);
  room.players.forEach(p => ddzPlayerRoom.delete(p.id));
  ddzRooms.delete(roomId);
  io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
}

function ddzLeaveRoom(id) {
  const roomId = ddzPlayerRoom.get(id);
  if (!roomId) return;
  ddzClearTurnTimer(roomId);
  const room = ddzRooms.get(roomId);

  // Clean up game state if active game exists
  if (room && ddzGameStates.has(roomId)) {
    ddzGameStates.delete(roomId);
    room.players.filter(p => p.id !== id).forEach(p => {
      io.to(p.id).emit('ddz:room-error', '游戏已中断（玩家退出）');
    });
  }

  if (room) {
    room.players = room.players.filter(p => p.id !== id);
    if (room.players.length === 0) {
      // Cancel timer and clean up
      if (ddzRoomTimers.has(roomId)) { clearTimeout(ddzRoomTimers.get(roomId)); ddzRoomTimers.delete(roomId); }
      ddzRooms.delete(roomId);
    } else {
      // Bot-only check: if no human players left, dismiss
      const hasHuman = room.players.some(p => !p.id.startsWith('ai_'));
      if (!hasHuman) {
        ddzDismissRoom(roomId);
        return;
      }
      if (room.hostId === id) room.hostId = room.players[0].id;
      io.to(roomId).emit('ddz:room-update', { name: room.name, hostId: room.hostId, players: room.players });
    }
  }
  ddzPlayerRoom.delete(id);
}

// ─── Turn Timer ────────────────────────────────────────────
function ddzStartTurnTimer(roomId) {
  ddzClearTurnTimer(roomId);
  const game = ddzGameStates.get(roomId);
  if (!game) return;
  // If current player has auto-play on, trigger AI immediately
  if (game.autoPlay && game.autoPlay[game.currentPlayer]) {
    setTimeout(() => ddzTriggerAIPlay(roomId), 100);
    return;
  }
  const timer = setTimeout(() => ddzTimeoutPlay(roomId), TURN_TIMEOUT);
  ddzTurnTimers.set(roomId, timer);
}

function ddzClearTurnTimer(roomId) {
  if (ddzTurnTimers.has(roomId)) {
    clearTimeout(ddzTurnTimers.get(roomId));
    ddzTurnTimers.delete(roomId);
  }
}

function ddzTimeoutPlay(roomId) {
  const game = ddzGameStates.get(roomId);
  if (!game || game.phase !== 'play') return;
  const room = ddzRooms.get(roomId);
  if (!room) return;

  const playerId = game.currentPlayer;

  // If auto-play is on for this player, trigger AI play
  if (game.autoPlay && game.autoPlay[playerId]) {
    ddzTriggerAIPlay(roomId);
    return;
  }

  // Auto-pass or auto-lead
  if (!game.lastPlay) {
    // Leading player must play — play lowest single
    const hand = game.hands[playerId];
    if (hand && hand.length > 0) {
      const sorted = [...hand].sort((a, b) => VALUE_ORDER[a.value] - VALUE_ORDER[b.value]);
      const cards = [sorted[0]];
      game.hands[playerId] = hand.filter(c => c !== sorted[0]);
      const playType = getCardType(cards);
      if (playType) {
        game.lastPlay = { playerId, cards, type: playType.type, main: playType.main, length: playType.length };
        game.passCount = 0;
        game.playerMoves[playerId] = { cards, type: playType.type };
        const role = game.roles.find(r => r.id === playerId);
        if (role) role.cardCount = game.hands[playerId].length;
        if (game.hands[playerId].length === 0) {
          game.phase = 'ended'; ddzClearTurnTimer(roomId);
          game.winner = { id: playerId, name: role ? role.name : '', type: role && role.isLandlord ? 'landlord' : 'farmer' };
          room.state = 'waiting';
          room.players.forEach(p => { if (!p.id.startsWith('ai_')) io.to(p.id).emit('ddz:game-over', { phase:'ended', players:game.roles, currentPlayer:null, lastPlay:game.lastPlay, passCount:0, bottomCards:game.bottomCards, winner:game.winner, myCards:game.hands[p.id]||[] }); });
          ddzGameStates.delete(roomId);
          io.emit('ddz:room-list', [...ddzRooms.values()].map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, state: r.state })));
          return;
        }
        const idx = game.roles.findIndex(r => r.id === playerId);
        game.currentPlayer = game.roles[(idx + 1) % 3].id;
        room.players.forEach(p => { if (!p.id.startsWith('ai_')) io.to(p.id).emit('ddz:game-state', { phase:'play', players:game.roles, currentPlayer:game.currentPlayer, lastPlay:game.lastPlay, passCount:0, bottomCards:game.bottomCards, winner:null, myCards:game.hands[p.id], playerMoves:game.playerMoves }); });
        if (game.currentPlayer.startsWith('ai_')) setTimeout(() => ddzTriggerAI(roomId), 1000);
        else ddzStartTurnTimer(roomId);
        return;
      }
    }
    return;
  }

  game.passCount++;
  game.playerMoves[playerId] = { cards: [], type: 'pass' };
  if (game.passCount >= 2) {
    game.currentPlayer = game.lastPlay.playerId;
    game.lastPlay = null;
    game.passCount = 0;
    game.playerMoves = {};
  } else {
    const idx = game.roles.findIndex(r => r.id === playerId);
    game.currentPlayer = game.roles[(idx + 1) % 3].id;
  }

  room.players.forEach(p => {
    if (p.id.startsWith('ai_')) return;
    io.to(p.id).emit('ddz:game-state', {
      phase: 'play', players: game.roles, currentPlayer: game.currentPlayer,
      lastPlay: game.lastPlay, passCount: game.passCount,
      bottomCards: game.bottomCards, winner: null, myCards: game.hands[p.id],
      playerMoves: game.playerMoves,
    });
  });

  // Start timer for next player if human, or trigger AI
  if (game.currentPlayer.startsWith('ai_')) {
    setTimeout(() => ddzTriggerAI(roomId), 1000);
  } else {
    ddzStartTurnTimer(roomId);
  }
}

function ddzTriggerAIPlay(roomId) {
  const game = ddzGameStates.get(roomId);
  if (!game || game.phase !== 'play') return;
  const room = ddzRooms.get(roomId);
  if (!room) return;
  ddzAIPlay(game, room);
  // Start turn timer if the next player is human
  if (game.phase === 'play' && game.currentPlayer && !game.currentPlayer.startsWith('ai_')) {
    ddzStartTurnTimer(roomId);
  }
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
  // Start turn timer if the next player is human
  if (game.phase === 'play' && game.currentPlayer && !game.currentPlayer.startsWith('ai_')) {
    ddzStartTurnTimer(roomId);
  }
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
      // Try to play pairs or triples first (clear hand faster)
      const pairVal = sortedVals.find(v => groups[v].length >= 2);
      const tripleVal = sortedVals.find(v => groups[v].length >= 3);
      if (tripleVal && Math.random() < 0.3) {
        chosen = groups[tripleVal].slice(0, 3);
      } else if (pairVal && Math.random() < 0.4) {
        chosen = groups[pairVal].slice(0, 2);
      } else {
        const lowestVal = sortedVals[0];
        chosen = [groups[lowestVal][0]];
      }
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
      } else if (last.type === 'triple') {
        const mainOrder = VALUE_ORDER[last.main] || 0;
        for (const v of sortedVals) {
          if (groups[v].length >= 3 && VALUE_ORDER[v] > mainOrder) {
            chosen = groups[v].slice(0, 3);
            break;
          }
        }
      } else if (last.type === 'triple_one') {
        const mainOrder = VALUE_ORDER[last.main] || 0;
        for (const v of sortedVals) {
          if (groups[v].length >= 3 && VALUE_ORDER[v] > mainOrder) {
            const triple = groups[v].slice(0, 3);
            const rest = hand.filter(c => c.value !== v);
            if (rest.length > 0) {
              chosen = [...triple, rest[0]];
              break;
            }
          }
        }
      } else if (last.type === 'triple_pair') {
        const mainOrder = VALUE_ORDER[last.main] || 0;
        for (const v of sortedVals) {
          if (groups[v].length >= 3 && VALUE_ORDER[v] > mainOrder) {
            const triple = groups[v].slice(0, 3);
            const rest = hand.filter(c => c.value !== v);
            const pairVals = [...new Set(rest.map(c => c.value))].filter(pv => groups[pv].length >= 2);
            if (pairVals.length > 0) {
              chosen = [...triple, ...groups[pairVals[0]].slice(0, 2)];
              break;
            }
          }
        }
      } else if (last.type === 'straight') {
        const mainOrder = VALUE_ORDER[last.main] || 0;
        const sLen = last.length;
        const singleVals = sortedVals.filter(v => groups[v].length >= 1 && VALUE_ORDER[v] <= VALUE_ORDER['A']);
        for (let i = 0; i <= singleVals.length - sLen; i++) {
          const seq = singleVals.slice(i, i + sLen);
          const consec = seq.every((v, j) => j === 0 || VALUE_ORDER[v] - VALUE_ORDER[seq[j-1]] === 1);
          if (consec && VALUE_ORDER[seq[sLen-1]] > mainOrder) {
            chosen = seq.map(v => groups[v][0]);
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
        game.playerMoves[aiId] = { cards: [], type: 'pass' };
        if (game.passCount >= 2) {
          game.currentPlayer = game.lastPlay.playerId;
          game.lastPlay = null;
          game.passCount = 0;
          game.playerMoves = {};
        } else {
          const idx = game.roles.findIndex(r => r.id === aiId);
          game.currentPlayer = game.roles[(idx + 1) % 3].id;
        }
        room.players.forEach(p => {
          if (p.id.startsWith('ai_')) return;
          io.to(p.id).emit('ddz:game-state', {
            phase: 'play', players: game.roles, currentPlayer: game.currentPlayer,
            lastPlay: game.lastPlay, passCount: game.passCount, bottomCards: game.bottomCards, winner: null,
            myCards: game.hands[p.id],
            playerMoves: game.playerMoves,
          });
        });
        if (game.currentPlayer.startsWith('ai_')) setTimeout(() => ddzTriggerAI(room.id), 1000);
        else ddzStartTurnTimer(room.id);
        return;
      }
    }

    // Play chosen cards
    const chosenKeys = new Set(chosen.map(c => `${c.suit}_${c.value}`));
    game.hands[aiId] = hand.filter(c => !chosenKeys.has(`${c.suit}_${c.value}`));

    const playType = getCardType(chosen);
    if (!playType) { game.passCount++; return; }
  game.lastPlay = { playerId: aiId, cards: chosen, type: playType.type, main: playType.main, length: playType.length };
  game.playerMoves[aiId] = { cards: chosen, type: playType.type };
  game.passCount = 0;

  const role = game.roles.find(r => r.id === aiId);
  if (role) role.cardCount = game.hands[aiId].length;

  // Check win
  if (game.hands[aiId].length === 0) {
    game.phase = 'ended';
    ddzClearTurnTimer(room.id);
    game.winner = { id: aiId, name: role ? role.name : 'Bot', type: role && role.isLandlord ? 'landlord' : 'farmer' };
    room.state = 'waiting';
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return;
      io.to(p.id).emit('ddz:game-over', {
        phase: 'ended', players: game.roles, currentPlayer: null, lastPlay: game.lastPlay, passCount: 0,
        bottomCards: game.bottomCards, winner: game.winner, myCards: game.hands[p.id] || [],
        playerMoves: game.playerMoves,
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
      lastPlay: game.lastPlay, passCount: game.passCount, bottomCards: game.bottomCards, winner: null,
      myCards: game.hands[p.id],
      playerMoves: game.playerMoves,
    });
  });

  if (game.currentPlayer.startsWith('ai_')) {
    setTimeout(() => ddzTriggerAI(room.id), 1000);
  } else {
    ddzStartTurnTimer(room.id);
  }
} catch (e) {
  console.error('[ddzAI]', e);
}
}

// ─── AI Bidding ────────────────────────────────────────────
function ddzTriggerAIBid(roomId) {
  const game = ddzGameStates.get(roomId);
  if (!game || game.phase !== 'bidding') return;
  if (!game.currentBidder.startsWith('ai_')) return;
  const room = ddzRooms.get(roomId);
  if (!room) return;
  ddzAIBid(game, room);
}

function ddzAIBid(game, room) {
  const aiId = game.currentBidder;
  const hand = game.hands[aiId];
  const bid = ddzCalcAIBid(hand, game.currentBid);

  // Record bid
  game.bids.push({ playerId: aiId, bid });
  game.bidCount++;
  if (bid > game.currentBid) {
    game.currentBid = bid;
  }

  if (game.bidCount >= 3) {
    finishDDZBidding(room.id, game, room);
  } else {
    const idx = room.players.findIndex(p => p.id === aiId);
    game.currentBidder = room.players[(idx + 1) % 3].id;

    // Broadcast bid-phase to human players
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return;
      io.to(p.id).emit('ddz:bid-phase', {
        phase: 'bidding',
        currentBidder: game.currentBidder,
        currentBid: game.currentBid,
        bids: game.bids,
        players: game.roles,
        myCards: game.hands[p.id],
        bottomCards: game.bottomCards,
        winner: null,
      });
    });

    if (game.currentBidder.startsWith('ai_')) {
      setTimeout(() => ddzTriggerAIBid(room.id), 800);
    }
  }
}

function ddzCalcAIBid(hand, currentBid) {
  let score = 0;
  for (const c of hand) {
    if (c.value === 'big') score += 3;
    else if (c.value === 'small') score += 3;
    else if (c.value === '2') score += 1;
    else if (c.value === 'A') score += 0.5;
  }

  // Strong hand -> 抢地主
  if (score >= 5) {
    if (currentBid < 3) return currentBid + 1;
    return 0;
  }
  // Moderate hand -> 叫地主 if nobody has, or 抢地主 from 1分
  if (score >= 3) {
    if (currentBid === 0) return 1;
    if (currentBid === 1) return 2;
    return 0;
  }
  // Weak hand -> 不叫
  return 0;
}

// ─── Finish Bidding ────────────────────────────────────────
function finishDDZBidding(roomId, game, room) {
  // Find highest bidder
  let highestBidder = null;
  let highestBid = 0;
  for (const b of game.bids) {
    if (b.bid > highestBid) {
      highestBid = b.bid;
      highestBidder = b.playerId;
    }
  }

  if (highestBid === 0) {
    // All passed — random landlord
    const randIdx = Math.random() * 3 | 0;
    highestBidder = room.players[randIdx].id;
  }

  {
    // Landlord determined — give bottom cards
    game.landlordId = highestBidder;
    game.hands[highestBidder] = sortCards([...game.hands[highestBidder], ...game.bottomCards]);

    // Update roles with final card counts and landlord status
    game.roles = room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: game.hands[p.id].length,
      isLandlord: p.id === highestBidder,
    }));

    // Emit bid-result to all human players
    room.players.forEach(p => {
      if (p.id.startsWith('ai_')) return;
      io.to(p.id).emit('ddz:bid-result', {
        phase: 'bid-result',
        landlordId: highestBidder,
        bid: game.currentBid,
        players: game.roles,
        bottomCards: game.bottomCards,
        myCards: game.hands[p.id],
        winner: null,
        playerMoves: game.playerMoves,
      });
    });

    // Transition to play phase after 2 second delay
    setTimeout(() => {
      game.phase = 'play';
      game.currentPlayer = highestBidder;
      game.lastPlay = null;
      game.passCount = 0;

      room.players.forEach(p => {
        if (p.id.startsWith('ai_')) return;
        io.to(p.id).emit('ddz:game-state', {
          phase: 'play',
          players: game.roles,
          currentPlayer: game.currentPlayer,
          lastPlay: null,
          passCount: 0,
          bottomCards: game.bottomCards,
          winner: null,
          myCards: game.hands[p.id],
          playerMoves: game.playerMoves,
        });
      });

      if (highestBidder.startsWith('ai_')) {
        setTimeout(() => ddzTriggerAI(roomId), 1000);
      } else {
        ddzStartTurnTimer(roomId);
      }
    }, 2000);
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
