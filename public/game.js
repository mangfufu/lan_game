// ═══════════════════════════════════════════════════════════
// Snake Battle + Game Hall
// ═══════════════════════════════════════════════════════════

const socket = io();
let myId = null;
let gameState = null;
let mySnake = null;
let isDead = false;
let prevScore = 0;
let sprintActive = false;
let lastSprintRelease = 0;
const SPRINT_COOLDOWN = 3000;
const MIN_SPRINT_LENGTH = 6;
let timerRemaining = 5 * 60 * 1000;
let clientDir = null; // last locally-pressed direction for instant visual feedback
// ─── DOM shortcuts ────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── Skin ─────────────────────────────────────────────────
const COLORS = [
  '#e74c3c','#2ecc71','#3498db','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#ff6b81','#00d2d3','#95e600','#e056fd','#54a0ff',
];
const PATTERNS = ['classic','striped','glow','gradient'];
const PATTERN_LABELS = { classic:'纯色', striped:'条纹', glow:'霓虹', gradient:'渐变' };
let selColor = '#2ecc71';
let selPattern = 'classic';

const CELL = 12, GRID_GAP = 1, DC = CELL + GRID_GAP;

// ─── Hall navigation ──────────────────────────────────────
function hideAll() {
  ['hall','snake-config','game-screen','ddz-rooms','ddz-room','ddz-game','ddz-result'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const go = document.getElementById('gameover-overlay');
  if (go) go.style.display = 'none';
}

function showHall() { hideAll(); document.getElementById('hall').style.display = 'flex'; }

document.getElementById('lan-ip').textContent = `${location.hostname}:${location.port}`;

// Sync name to server on input
document.getElementById('name-input').addEventListener('input', () => {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  socket.emit('set-name', name.substring(0, 16));
});

let skinChosen = false;

// ─── Snake config skin picker ─────────────────────────────
const scp = document.getElementById('snake-color-picker');
if (scp) {
  COLORS.forEach(c => {
    const el = document.createElement('div');
    el.className = 'color-swatch' + (c === selColor ? ' active' : '');
    el.style.background = c;
    el.addEventListener('click', () => {
      scp.querySelectorAll('.color-swatch').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); selColor = c; skinChosen = true;
    });
    scp.appendChild(el);
  });
}
const spp = document.getElementById('snake-pattern-picker');
if (spp) {
  PATTERNS.forEach(p => {
    const el = document.createElement('button');
    el.className = 'pattern-btn' + (p === selPattern ? ' active' : '');
    el.textContent = PATTERN_LABELS[p] || p;
    el.addEventListener('click', () => {
      spp.querySelectorAll('.pattern-btn').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); selPattern = p; skinChosen = true;
    });
    spp.appendChild(el);
  });
}

// ═══════════════════════════════════════════════════════════
// SNAKE BATTLE
// ═══════════════════════════════════════════════════════════

// ─── Card click → show config ────────────────────────────
document.getElementById('card-snake').addEventListener('click', () => {
  hideAll();
  document.getElementById('snake-config').style.display = 'flex';
});

document.getElementById('snake-start-btn').addEventListener('click', () => {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  let color = selColor, pattern = selPattern;
  if (!skinChosen) {
    color = COLORS[Math.random() * COLORS.length | 0];
    pattern = PATTERNS[Math.random() * PATTERNS.length | 0];
  }
  socket.emit('join', { name, color, skin: pattern });
});

// ─── Socket events ────────────────────────────────────────
socket.on('welcome', (data) => { myId = data.id; });

socket.on('init', (data) => {
  myId = data.id;
  gameState = data.state;
  hideAll();
  document.getElementById('game-screen').style.display = 'flex';
  const canvas = document.getElementById('game-canvas');
  canvas.width = gameState.cols * DC + GRID_GAP;
  canvas.height = gameState.rows * DC + GRID_GAP;
  prevScore = 0; isDead = false;
});

socket.on('state', (state) => {
  gameState = state;
  const canvas = document.getElementById('game-canvas');
  canvas.width = state.cols * DC + GRID_GAP;
  canvas.height = state.rows * DC + GRID_GAP;
  mySnake = state.snakes.find(s => s.id === myId) || null;
  clientDir = null;
  isDead = mySnake ? !mySnake.alive : false;
  if (mySnake && mySnake.score !== prevScore) {
    if (mySnake.score > prevScore) playEat();
    prevScore = mySnake.score;
  }
  document.getElementById('death-overlay').style.display = isDead ? 'flex' : 'none';
  if (isDead) document.getElementById('death-score').textContent = `得分: ${mySnake?.score || 0}`;
  updateUI(); draw();
});

socket.on('timer', (data) => { timerRemaining = data.remaining; });

socket.on('game-start', () => {
  hideAll();
  document.getElementById('game-screen').style.display = 'flex';
  playGameStart();
});

socket.on('game-over', (data) => {
  document.getElementById('gameover-overlay').style.display = 'flex';
  const wt = document.getElementById('winner-text');
  if (data.winner) {
    const me = data.winner.id === myId;
    wt.textContent = `🐍 ${esc(data.winner.name)}${me ? ' (你)' : ''} 获胜！ — ${data.winner.score}分`;
  } else wt.textContent = '平局！';
  const fl = document.getElementById('final-score-list');
  fl.innerHTML = data.scores.sort((a,b)=>b.score-a.score).map((s,i)=>{
    const me = s.id === myId;
    return `<li><span class="final-rank">#${i+1}</span><span class="player-bullet" style="background:${s.color}"></span><span class="final-name">${esc(s.name)}${me ? ' (你)' : ''}</span><span class="final-score">${s.score}</span></li>`;
  }).join('');
  playGameOver();
});

socket.on('player-respawn', () => { isDead = false; document.getElementById('death-overlay').style.display = 'none'; });

// ─── Snake UI ─────────────────────────────────────────────
function updateUI() {
  if (!gameState) return;
  const pct = Math.max(0, (timerRemaining / (5*60*1000)) * 100);
  document.getElementById('timer-fill').style.width = pct + '%';
  const ts = Math.ceil(timerRemaining / 1000);
  document.getElementById('timer-text').textContent = `${Math.floor(ts/60)}:${String(ts%60).padStart(2,'0')}`;

  const sp = document.getElementById('sprint-indicator');
  if (sprintActive && mySnake && mySnake.alive) { sp.style.display = 'block'; sp.textContent = `⚡ 冲刺中 (${mySnake.body.length}节 · ${mySnake.score}分)`; }
  else sp.style.display = 'none';

  // Sprint cooldown indicator
  let cdEl = document.getElementById('sprint-cooldown');
  if (!cdEl) {
    cdEl = document.createElement('div');
    cdEl.id = 'sprint-cooldown';
    document.querySelector('.game-main').appendChild(cdEl);
  }
  const cdRemaining = SPRINT_COOLDOWN - (Date.now() - lastSprintRelease);
  if (cdRemaining > 0 && !sprintActive) {
    cdEl.style.display = 'block';
    cdEl.textContent = `⏳ 冲刺冷却 (${(cdRemaining / 1000).toFixed(1)}s)`;
  } else {
    cdEl.style.display = 'none';
  }

  document.getElementById('player-count').textContent = gameState.snakes.length;
  document.getElementById('player-list').innerHTML = gameState.snakes.map(s => {
    const dot = `<span class="player-bullet" style="background:${s.color}"></span>`;
    return `<li class="${s.alive?'alive':'dead'}">${dot}<span class="player-name">${esc(s.id===myId?s.name+' (你)':s.name)}</span><span class="player-status">${s.alive?'存活':'阵亡'}</span></li>`;
  }).join('');

  const sorted = [...gameState.snakes].sort((a,b)=>b.score-a.score);
  document.getElementById('score-list').innerHTML = sorted.map((s,i)=>{
    const dot = `<span class="player-bullet" style="background:${s.color}"></span>`;
    return `<li><span class="score-rank">#${i+1}</span>${dot}<span class="score-name">${esc(s.id===myId?s.name+' (你)':s.name)}</span><span class="score-val">${s.score}${s.alive?'':' 💀'}</span></li>`;
  }).join('');

  // Game info panel — longest snake + flavor text
  const gi = document.getElementById('game-info');
  let infoParts = [];
  if (gameState.longestSnake) {
    infoParts.push(`🐍 最长: ${esc(gameState.longestSnake.name)} (${gameState.longestSnake.length}节)`);
  }
  if (gameState.flavorText) {
    infoParts.push(`💬 ${gameState.flavorText}`);
  }
  gi.textContent = infoParts.length > 0 ? infoParts.join(' · ') : '—';

  // Power-up descriptions panel
  const puPanel = document.getElementById('powerup-list');
  if (puPanel) {
    const powerupDefs = [
      { emoji: '⭐', name: '金食物', desc: '+3分 +3节' },
      { emoji: '🛡️', name: '护盾', desc: '5秒无敌' },
      { emoji: '🌈', name: '炫光', desc: '迷惑对手3秒' },
      { emoji: '🧲', name: '磁铁', desc: '吸引周围3格食物' },
      { emoji: '❄️', name: '冰冻', desc: '冻结所有对手2秒' },
      { emoji: '🌀', name: '瞬移', desc: '传送至随机位置' },
    ];
    puPanel.innerHTML = powerupDefs.map(p =>
      `<li style="display:flex;gap:4px;padding:2px 0;font-size:.75rem;border-bottom:1px solid #1e1e2f">
        <span>${p.emoji}</span>
        <span style="color:#ddd">${p.name}</span>
        <span style="color:#888;margin-left:auto">${p.desc}</span>
      </li>`
    ).join('');
  }
}

// ─── Canvas ───────────────────────────────────────────────
function draw() {
  if (!gameState) return;
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0f0f17'; ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#191925'; ctx.lineWidth = 0.5;
  for (let x = 0; x <= gameState.cols; x++) { ctx.beginPath(); ctx.moveTo(x*DC,0); ctx.lineTo(x*DC,h); ctx.stroke(); }
  for (let y = 0; y <= gameState.rows; y++) { ctx.beginPath(); ctx.moveTo(0,y*DC); ctx.lineTo(w,y*DC); ctx.stroke(); }

  for (const f of gameState.food) {
    const x = f.x*DC+GRID_GAP, y = f.y*DC+GRID_GAP;
    ctx.fillStyle = f.color; ctx.shadowColor = f.color; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.arc(x+CELL/2, y+CELL/2, CELL/2-1, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Powerups — flashy
  if (gameState.powerups) {
    for (const p of gameState.powerups) {
      const x = p.x*DC+GRID_GAP, y = p.y*DC+GRID_GAP;
      const pulse = Math.sin(Date.now() / 200) * 0.3 + 0.7;
      // Outer glow ring
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 20 + 10 * pulse;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.3 + 0.2 * pulse;
      ctx.beginPath();
      ctx.arc(x+CELL/2, y+CELL/2, CELL/2 + 4, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Core
      ctx.shadowBlur = 15;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x+CELL/2, y+CELL/2, CELL/2+1, 0, Math.PI*2);
      ctx.fill();
      // Emoji
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const emojiMap = { gold: '⭐', shield: '🛡️', rainbow: '🌈', magnet: '🧲', freeze: '❄️', warp: '🌀' };
      ctx.fillText(emojiMap[p.type] || '?', x+CELL/2, y+CELL/2);
      ctx.shadowBlur = 0;
    }
  }

  for (const s of gameState.snakes) {
    if (!s.alive) continue;
    drawSnakeBody(ctx, s.body, s.color, s.skin, CELL, sprintActive && s.id===myId);
    if (s.body.length > 0) {
      const head = s.body[0];
      const hx = head.x*DC+GRID_GAP, hy = head.y*DC+GRID_GAP;
      let dx, dy;
      if (s.id === myId && clientDir) {
        const dirMap = { right: [1,0], left: [-1,0], up: [0,-1], down: [0,1] };
        [dx, dy] = dirMap[clientDir] || [1, 0];
      } else {
        dx = s.body.length>1 ? s.body[0].x-s.body[1].x : 1;
        dy = s.body.length>1 ? s.body[0].y-s.body[1].y : 0;
      }
      let e1x=hx+CELL*0.65, e1y=hy+CELL*0.25, e2x=hx+CELL*0.65, e2y=hy+CELL*0.25;
      if (dx<0) { e1x=hx+CELL*0.25; e2x=hx+CELL*0.25; }
      else if (dy<0) { e1x=hx+CELL*0.25; e1y=hy+CELL*0.25; e2x=hx+CELL*0.65; e2y=hy+CELL*0.25; }
      else if (dy>0) { e1x=hx+CELL*0.25; e1y=hy+CELL*0.65; e2x=hx+CELL*0.65; e2y=hy+CELL*0.65; }
      ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(e1x,e1y,2,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(e2x,e2y,2,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(e1x,e1y,1,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(e2x,e2y,1,0,Math.PI*2); ctx.fill();
    }
    if (s.body.length > 0) {
      const head = s.body[0];
      ctx.fillStyle = s.id===myId ? '#fff' : '#aaa';
      ctx.font = 'bold 10px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(s.id===myId ? s.name+' (你)' : s.name, head.x*DC+CELL/2, head.y*DC-4);

      // Shield — pulsing bubble
      if (s.shieldActive) {
        const head = s.body[0];
        const hx = head.x*DC+GRID_GAP, hy = head.y*DC+GRID_GAP;
        const pulse = Math.sin(Date.now() / 150) * 0.3 + 0.7;
        ctx.shadowColor = '#00BFFF';
        ctx.shadowBlur = 25 * pulse;
        ctx.strokeStyle = `rgba(0,191,255,${0.3 * pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx+CELL/2, hy+CELL/2, CELL/2 + 6, 0, Math.PI*2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      // Magnet — golden eating range circle
      if (s.magnetActive) {
        const head = s.body[0];
        const hx = head.x*DC+GRID_GAP, hy = head.y*DC+GRID_GAP;
        const pulse = Math.sin(Date.now() / 200) * 0.2 + 0.8;
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = `rgba(255,215,0,${0.3 * pulse})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(hx+CELL/2, hy+CELL/2, DC * 3, 0, Math.PI*2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
      // Confused — spinning question marks
      if (s.confused) {
        const head = s.body[0];
        const spin = Math.floor(Date.now() / 300) % 2;
        ctx.shadowColor = '#FF69B4';
        ctx.shadowBlur = 10;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(spin === 0 ? '❓' : '❔', head.x*DC+CELL/2, head.y*DC-18);
        ctx.shadowBlur = 0;
      }
      // Frozen — ice sparkle
      if (s.frozen) {
        const head = s.body[0];
        const sparkle = Math.floor(Date.now() / 400) % 3;
        ctx.shadowColor = '#87CEEB';
        ctx.shadowBlur = 12;
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        const icons = ['❄️', '✨', '💎'];
        ctx.fillText(icons[sparkle], head.x*DC+CELL/2, head.y*DC-18);
        ctx.shadowBlur = 0;
      }
    }
  }
}

function drawSnakeBody(c, body, color, skin, cellSize, sprinting) {
  const dc = cellSize + GRID_GAP;
  for (let i = 0; i < body.length; i++) {
    const seg = body[i], x = seg.x*dc+GRID_GAP, y = seg.y*dc+GRID_GAP;
    const alpha = 1 - (i/body.length)*0.45, isHead = i===0;
    let fc = color;
    if (skin === 'striped') fc = i%2===0 ? color : darken(color, 30);
    else if (skin === 'gradient') fc = lerpColor(color, '#ffffff', 1 - i/body.length);
    c.globalAlpha = alpha;
    if (skin === 'glow' || sprinting) {
      c.shadowColor = sprinting ? '#ffffff' : color;
      c.shadowBlur = sprinting ? 18 : (isHead ? 12 : 6);
    } else c.shadowBlur = 0;
    c.fillStyle = fc;
    if (isHead) {
      const r = 3;
      c.beginPath(); c.moveTo(x+r,y); c.lineTo(x+cellSize-r,y);
      c.quadraticCurveTo(x+cellSize,y,x+cellSize,y+r);
      c.lineTo(x+cellSize,y+cellSize-r); c.quadraticCurveTo(x+cellSize,y+cellSize,x+cellSize-r,y+cellSize);
      c.lineTo(x+r,y+cellSize); c.quadraticCurveTo(x,y+cellSize,x,y+cellSize-r);
      c.lineTo(x,y+r); c.quadraticCurveTo(x,y,x+r,y);
      c.fill();
    } else c.fillRect(x, y, cellSize, cellSize);
    c.globalAlpha = 1; c.shadowBlur = 0;
  }
}

function darken(hex, amt) {
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  r=Math.max(0,r-amt); g=Math.max(0,g-amt); b=Math.max(0,b-amt);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
function lerpColor(a,b,t) {
  const ar=parseInt(a.slice(1,3),16),ag=parseInt(a.slice(3,5),16),ab=parseInt(a.slice(5,7),16);
  const br=parseInt(b.slice(1,3),16),bg=parseInt(b.slice(3,5),16),bb=parseInt(b.slice(5,7),16);
  return `#${(Math.round(ar+(br-ar)*t)).toString(16).padStart(2,'0')}${(Math.round(ag+(bg-ag)*t)).toString(16).padStart(2,'0')}${(Math.round(ab+(bb-ab)*t)).toString(16).padStart(2,'0')}`;
}

// ─── Input ────────────────────────────────────────────────
const KEY_DIR = { ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right', w:'up',W:'up',s:'down',S:'down',a:'left',A:'left',d:'right',D:'right' };
document.addEventListener('keydown', (e) => {
  const dir = KEY_DIR[e.key];
  if (dir) { e.preventDefault(); clientDir = dir; socket.emit('dir', dir); }
  if (e.key===' '||e.code==='Space') { e.preventDefault(); if (Date.now() - lastSprintRelease < SPRINT_COOLDOWN) return; sprintActive=true; socket.emit('sprint',true); initAudio(); playSprint(); }
});
document.addEventListener('keyup', (e) => {
  if (e.key===' '||e.code==='Space') { e.preventDefault(); sprintActive=false; socket.emit('sprint',false); lastSprintRelease = Date.now(); }
});
window.addEventListener('blur', () => { if (sprintActive) { sprintActive=false; socket.emit('sprint',false); lastSprintRelease = Date.now(); } });

// ─── Custom Modal ─────────────────────────────────────────
function showModal(msg) {
  document.getElementById('modal-text').textContent = msg;
  document.getElementById('modal-buttons').innerHTML = '<button class="btn-primary" onclick="closeModal()">确定</button>';
  document.getElementById('custom-modal').style.display = 'flex';
}
function showConfirm(msg, onConfirm) {
  document.getElementById('modal-text').textContent = msg;
  document.getElementById('modal-buttons').innerHTML =
    '<button class="btn-primary" onclick="confirmAction(true)">确定</button>' +
    '<button class="back-btn" onclick="confirmAction(false)">取消</button>';
  document.getElementById('custom-modal').style.display = 'flex';
  window._confirmCb = onConfirm;
}
function closeModal() {
  document.getElementById('custom-modal').style.display = 'none';
}
function confirmAction(confirmed) {
  closeModal();
  if (window._confirmCb) window._confirmCb(confirmed);
}
window.showModal = showModal;
window.closeModal = closeModal;
window.confirmAction = confirmAction;

// ═══════════════════════════════════════════════════════════
// DOUDIZHU — Room System
// ═══════════════════════════════════════════════════════════

let ddzMyRoom = null; // room id

// Timer for turn countdown
let ddzTimerInterval = null;
let ddzAutoActive = false;

function ddzStartLocalTimer(seconds) {
  ddzStopLocalTimer();
  let remaining = seconds;
  const el = document.getElementById('ddz-timer-badge');
  if (!el) return;
  el.textContent = remaining;
  ddzTimerInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      ddzStopLocalTimer();
    } else {
      const badge = document.getElementById('ddz-timer-badge');
      if (badge) badge.textContent = remaining;
    }
  }, 1000);
}

function ddzStopLocalTimer() {
  if (ddzTimerInterval) {
    clearInterval(ddzTimerInterval);
    ddzTimerInterval = null;
  }
}

function ddzToggleAuto() {
  ddzAutoActive = !ddzAutoActive;
  socket.emit('ddz:auto-play', { active: ddzAutoActive });
  // Update all auto-btn elements (player info box)
  document.querySelectorAll('#ddz-auto-btn').forEach(btn => {
    btn.textContent = ddzAutoActive ? '取消托管' : '托管';
    btn.className = ddzAutoActive ? 'ddz-p-auto active' : 'ddz-p-auto';
  });
}

// ─── Card click ───────────────────────────────────────────
document.getElementById('card-doudizhu').addEventListener('click', () => {
  hideAll();
  document.getElementById('ddz-rooms').style.display = 'flex';
  refreshDDZRooms();
});

function refreshDDZRooms() {
  socket.emit('ddz:get-rooms');
}

// ─── Room list ────────────────────────────────────────────
socket.on('ddz:room-list', (list) => {
  const el = document.getElementById('ddz-room-list');
  document.getElementById('room-count').textContent = `${list.length} 个房间`;
  if (!list.length) { el.innerHTML = '<p class="hint">暂无房间，点击「创建房间」</p>'; return; }
  el.innerHTML = list.map(r => {
    const label = r.state === 'waiting' ? '等待中' : '游戏中';
    return `<div class="room-item">
      <div><div class="room-item-name">${esc(r.name)}</div>
      <div class="room-item-meta">${label} · ${r.playerCount}/3 人</div></div>
      <button class="room-item-join" data-id="${r.id}">加入</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.room-item-join').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('ddz:join-room', btn.dataset.id));
  });
});

// ─── Create room ──────────────────────────────────────────
document.getElementById('ddz-create-btn').addEventListener('click', () => {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  socket.emit('ddz:create-room', { name: name + ' 的房间', playerName: name, color: selColor, skin: selPattern });
});

// ─── Join / room state ────────────────────────────────────
socket.on('ddz:room-joined', (data) => {
  ddzMyRoom = data.roomId;
  hideAll();
  document.getElementById('ddz-room').style.display = 'flex';
});

socket.on('ddz:room-update', (room) => {
  document.getElementById('ddz-room-title').textContent = `🃏 ${esc(room.name)}`;
  const list = document.getElementById('ddz-player-list');
  const isHost = room.hostId === myId;
  list.innerHTML = room.players.map(p => {
    const isHostPlayer = p.id === room.hostId;
    const dot = `<span class="player-bullet" style="background:${p.color}"></span>`;
    const kickBtn = isHost && !isHostPlayer ? `<button class="kick-btn" data-id="${p.id}">踢出</button>` : '';
    return `<li>${dot}${esc(p.name)}${isHostPlayer ? ' ⭐ 房主' : ''}${kickBtn}</li>`;
  }).join('');
  // Kick button handlers
  list.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showConfirm('确定踢出该玩家？', (ok) => {
        if (ok) socket.emit('ddz:kick-player', { playerId: btn.dataset.id });
      });
    });
  });
  document.getElementById('ddz-player-count').textContent = room.players.length;

  document.getElementById('ddz-start-btn').style.display = isHost && room.players.length >= 3 ? 'block' : 'none';
  document.getElementById('ddz-bot-btn').style.display = isHost && room.players.length < 3 ? 'block' : 'none';
  document.getElementById('ddz-dismiss-btn').style.display = isHost ? 'block' : 'none';
  document.getElementById('ddz-waiting-msg').style.display = (isHost || room.players.length >= 3) ? 'none' : 'block';
});

socket.on('ddz:room-error', (msg) => { showModal(msg); });

socket.on('ddz:return-to-room', () => {
  ddzState = null;
  ddzSelectedKeys = new Set();
  ddzAutoActive = false;
  ddzStopLocalTimer();
  hideAll();
  document.getElementById('ddz-room').style.display = 'flex';
  socket.emit('ddz:get-room');
});

socket.on('ddz:room-dismissed', () => {
  showModal('房间已被房主解散');
  if (ddzMyRoom) { ddzMyRoom = null; }
  showHall();
});

// ─── Start / leave ────────────────────────────────────────
document.getElementById('ddz-start-btn').addEventListener('click', () => {
  socket.emit('ddz:start-game');
});
document.getElementById('ddz-bot-btn').addEventListener('click', () => {
  socket.emit('ddz:add-bot');
});
document.getElementById('ddz-dismiss-btn').addEventListener('click', () => {
  showConfirm('确定解散房间？', (ok) => {
    if (ok) socket.emit('ddz:dismiss-room');
  });
});

function leaveDDZRoom() {
  socket.emit('ddz:leave-room');
  ddzMyRoom = null;
  showHall();
}
// Make leaveDDZRoom globally accessible (for onclick in HTML)
window.leaveDDZRoom = leaveDDZRoom;

// Auto-refresh room list
setInterval(() => {
  if (document.getElementById('ddz-rooms').style.display !== 'none') {
    refreshDDZRooms();
  }
}, 5000);

// ═══════════════════════════════════════════════════════════
// DOUDIZHU — Game Screen
// ═══════════════════════════════════════════════════════════

let ddzState = null;
let ddzSelectedKeys = new Set();
const VALUE_ORDER = {
  '3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,
  '10':8,'J':9,'Q':10,'K':11,'A':12,'2':13,'small':14,'big':15,
};
const SUIT_ORDER = { spade:0, heart:1, club:2, diamond:3, joker:4 };

function getCardColor(c) {
  if (c.suit === 'joker') return c.value === 'big' ? '#e74c3c' : '#2c3e50';
  return (c.suit === 'heart' || c.suit === 'diamond') ? '#e74c3c' : '#2c3e50';
}

function getCardDisplay(c) {
  const suitMap = { spade:'♠', heart:'♥', club:'♣', diamond:'♦', joker:'🃏' };
  const suit = suitMap[c.suit] || '';
  const val = c.value === 'small' ? '小王' : c.value === 'big' ? '大王' : c.value;
  return { suit, val };
}

function makeCardHTML(c, extra) {
  const { suit, val } = getCardDisplay(c);
  const color = getCardColor(c);
  const classes = 'ddz-card' + (c.suit === 'joker' ? ' ddz-card-joker' : '') + (extra?.cls ? ' ' + extra.cls : '');
  const data = extra?.key ? ` data-key="${extra.key}"` : '';
  return `<div class="${classes}" style="color:${color}"${data}>
    <span class="ddz-card-suit">${suit}</span>
    <span class="ddz-card-value">${val}</span>
  </div>`;
}

// ─── Socket handlers ──────────────────────────────────────
socket.on('ddz:game-start', (data) => {
  ddzState = data;
  ddzSelectedKeys = new Set();
  ddzAutoActive = false;
  ddzStopLocalTimer();
  hideAll();
  document.getElementById('ddz-game').style.display = 'block';
  renderDDZTable();
});

socket.on('ddz:game-state', (data) => {
  ddzState = data;
  ddzSelectedKeys = new Set();
  renderDDZTable();
});

socket.on('ddz:game-over', (data) => {
  ddzState = data;
  ddzSelectedKeys = new Set();
  ddzStopLocalTimer();
  // Check if I won
  const winner = data.winner;
  if (winner && winner.id === myId) ddzWinSound();
  else if (winner) ddzLoseSound();
  renderDDZTable();
});

socket.on('ddz:bid-phase', (data) => {
  ddzState = data;
  ddzSelectedKeys = new Set();
  renderDDZTable();
});

socket.on('ddz:bid-result', (data) => {
  ddzState = data;
  ddzSelectedKeys = new Set();
  renderDDZTable();
});

// ─── Render ───────────────────────────────────────────────
function renderDDZTable() {
  if (!ddzState) return;
  const state = ddzState;

  // Get my seat index
  let myIdx = -1;
  state.players.forEach((p, i) => { if (p.id === myId) myIdx = i; });

  // Render player info
  for (let i = 0; i < 3; i++) {
    const p = state.players[i];
    if (!p) continue;
    const el = document.getElementById(`ddz-p${i}`);
    const isMe = p.id === myId;
    const isActive = (state.phase === 'play' && state.currentPlayer === p.id) ||
                     (state.phase === 'bidding' && state.currentBidder === p.id);
    const isWinner = state.winner && state.winner.id === p.id;
    el.className = 'ddz-player-info' +
      (isActive ? ' active' : '') +
      (isWinner ? ' winner' : '');

    // Show bid status during bidding
    let bidHtml = '';
    if (state.bids && state.phase === 'bidding') {
      const pBid = state.bids.find(b => b.playerId === p.id);
      if (pBid) {
        const bidText = pBid.bid === 0 ? '不叫' :
          (pBid.bid === 1 ? '叫地主' : '抢地主 (' + pBid.bid + '分)');
        bidHtml = `<div class="ddz-p-bid">${bidText}</div>`;
      }
    }

    const timerBadge = state.phase === 'play' && state.currentPlayer === p.id
      ? '<span class="ddz-p-timer" id="ddz-timer-badge">25</span>'
      : '';
    const autoBtn = isMe
      ? `<div class="ddz-p-auto" id="ddz-auto-btn" onclick="ddzToggleAuto()">${ddzAutoActive ? '取消托管' : '托管'}</div>`
      : '';
    el.innerHTML = `
      <div class="ddz-p-name">${esc(p.name)}${isMe ? ' (你)' : ''}${timerBadge}</div>
      <div class="ddz-p-cards-count">${p.cardCount} 张</div>
      ${bidHtml}
      ${p.isLandlord ? '<div class="ddz-p-landlord">👑 地主</div>' : ''}
      ${autoBtn}
    `;
  }

  // Each player's played cards outside info box, toward table center
  for (let i = 0; i < 3; i++) {
    let cardEl = document.getElementById('ddz-cards-' + i);
    if (!cardEl) {
      cardEl = document.createElement('div');
      cardEl.id = 'ddz-cards-' + i;
      document.querySelector('.ddz-top-info').appendChild(cardEl);
    }
    const p = state.players[i];
    if (!p) { cardEl.innerHTML = ''; continue; }
    if (state.playerMoves && state.playerMoves[p.id]) {
      const move = state.playerMoves[p.id];
      if (move.cards && move.cards.length > 0) {
        cardEl.innerHTML = move.cards.map(c => makeCardHTML(c)).join('');
        cardEl.className = 'ddz-player-cards';
      } else if (move.type === 'pass') {
        cardEl.textContent = '不出';
        cardEl.className = 'ddz-player-cards pass';
      } else {
        cardEl.innerHTML = '';
        cardEl.className = 'ddz-player-cards';
      }
    } else {
      cardEl.innerHTML = '';
      cardEl.className = 'ddz-player-cards';
    }
  }

  // Bottom cards (hidden on game end — result overlay shows them)
  const bottomEl = document.getElementById('ddz-bottom-cards');
  if (state.bottomCards && state.bottomCards.length && state.phase !== 'ended') {
    if (state.phase === 'bidding') {
      // Face-down during bidding
      bottomEl.innerHTML = '<span class="ddz-bottom-label">底牌</span>' +
        state.bottomCards.map(() => '<div class="ddz-card back"></div>').join('') +
        '<span class="ddz-bottom-label">?</span>';
    } else {
      bottomEl.innerHTML = state.bottomCards.map(c => makeCardHTML(c)).join('');
    }
  } else {
    bottomEl.innerHTML = '';
  }

  // Play area
  const playArea = document.getElementById('ddz-play-area');
  if (state.phase === 'bidding') {
    // Bidding phase info
    const bids = state.bids || [];
    const curBidder = state.players.find(p => p.id === state.currentBidder);
    const curName = curBidder ? esc(curBidder.name) : '';
    const highestBid = state.currentBid || 0;

    let bidHtml = '';
    if (bids.length > 0) {
      bidHtml = bids.map(b => {
        const player = state.players.find(p2 => p2.id === b.playerId);
        const name = player ? esc(player.name) : '?';
        const txt = b.bid === 0 ? '不叫' :
          (b.bid === 1 ? '叫地主 (1分)' : '抢地主 (' + b.bid + '分)');
        return `<div class="ddz-bid-entry"><span class="ddz-bid-player">${name}</span> → <span class="ddz-bid-action">${txt}</span></div>`;
      }).join('');
    }

    playArea.innerHTML = `
      <div class="ddz-bid-title">👑 叫地主阶段</div>
      <div class="ddz-bid-current">当前最高叫分: <strong>${highestBid}</strong></div>
      <div class="ddz-bid-history">${bidHtml}</div>
      <div class="ddz-bid-hint">${state.currentBidder === myId ? '请选择:' : '等待 <strong>' + curName + '</strong> 叫分...'}</div>
    `;
  } else if (state.phase === 'bid-result') {
    const landlord = state.players.find(p => p.isLandlord);
    const lName = landlord ? esc(landlord.name) : '';
    playArea.innerHTML = `
      <div class="ddz-bid-title">🏆 叫地主结果</div>
      <div class="ddz-bid-result-info">地主: <strong>${lName}</strong> (${state.bid || state.currentBid}分)</div>
      <div class="ddz-bid-hint">底牌已分配，游戏即将开始...</div>
    `;
  } else if (state.lastPlay) {
    if (state.lastPlay.playerId === myId) {
      playArea.innerHTML = `<div style="font-size:.7rem;color:rgba(255,255,255,.5);margin-bottom:4px">你出了</div><div class="ddz-play-cards">${state.lastPlay.cards.map(c => makeCardHTML(c)).join('')}</div>`;
    } else {
      playArea.innerHTML = '';
    }
  } else {
    playArea.innerHTML = '<div class="ddz-play-hint" id="ddz-play-hint"></div>';
    const hintEl = document.getElementById('ddz-play-hint');
    if (hintEl) {
      if (state.phase === 'play') {
        const cur = state.players.find(p => p.id === state.currentPlayer);
        const curName = cur ? esc(cur.name) : '';
        if (state.currentPlayer === myId) {
          hintEl.textContent = '轮到你出牌了';
        } else {
          hintEl.textContent = curName + ' 思考中...';
        }
      }
    }
  }

  // My hand
  renderDDZHand(state.myCards || []);

  // Action buttons
  const actions = document.getElementById('ddz-actions');
  if (state.phase === 'bidding' && state.currentBidder === myId) {
    actions.style.display = 'flex';
    const currentBid = state.currentBid || 0;
    let html = '<button class="back-btn" onclick="ddzSendBid(0)">不叫</button>';
    if (currentBid < 3) {
      if (currentBid === 0) {
        html += '<button class="btn-primary" onclick="ddzSendBid(1)">叫地主</button>';
      } else {
        const nextBid = currentBid + 1;
        html += '<button class="btn-primary" onclick="ddzSendBid(' + nextBid + ')">抢地主 (' + nextBid + '分)</button>';
      }
    }
    actions.innerHTML = html;
  } else if (state.phase === 'play' && state.currentPlayer === myId) {
    actions.style.display = 'flex';
    // Restore play/pass buttons if they were wiped by bidding phase (with onclick for event binding)
    if (!document.getElementById('ddz-play-btn')) {
      actions.innerHTML = '<button id="ddz-play-btn" class="btn-primary" onclick="ddzPlayCards()">出牌</button><button id="ddz-pass-btn" class="back-btn" onclick="ddzPass()">不出</button>';
    }
    document.getElementById('ddz-pass-btn').style.display = state.lastPlay ? 'inline-block' : 'none';
    // Sync auto-play button state
    const autoBtn = document.getElementById('ddz-auto-btn');
    if (autoBtn) {
      autoBtn.textContent = ddzAutoActive ? '取消托管' : '托管';
      autoBtn.style.background = ddzAutoActive ? 'rgba(243,156,18,.2)' : 'transparent';
    }
  } else {
    actions.style.display = 'none';
  }

  // Result overlay
  const result = document.getElementById('ddz-result');
  if (state.phase === 'ended' && state.winner) {
    const w = state.winner;
    const isMe = w.id === myId;
    const wPlayer = state.players.find(p => p.id === w.id);
    const wName = wPlayer ? esc(wPlayer.name) : '';
    const title = isMe ? '🎉 你赢了！' : '😔 游戏结束';
    let detail = '';
    if (w.type === 'landlord') {
      detail = `地主 ${wName}${isMe ? '' : ''} 获胜！`;
    } else {
      detail = `农民 ${wName}${isMe ? '' : ''} 获胜！`;
    }
    document.getElementById('ddz-result-title').textContent = title;
    document.getElementById('ddz-result-detail').textContent = detail;

    // Reveal bottom cards
    const reveal = document.getElementById('ddz-bottom-reveal');
    if (state.bottomCards) {
      reveal.innerHTML = state.bottomCards.map(c => makeCardHTML(c)).join('');
    } else {
      reveal.innerHTML = '';
    }

    result.style.display = 'flex';
  } else {
    result.style.display = 'none';
  }

  // Turn timer
  if (state.phase === 'play' && state.currentPlayer === myId) {
    ddzStartLocalTimer(25);
  } else {
    ddzStopLocalTimer();
  }
  // Sync auto-play button state
  document.querySelectorAll('#ddz-auto-btn').forEach(btn => {
    btn.textContent = ddzAutoActive ? '取消托管' : '托管';
    btn.className = ddzAutoActive ? 'ddz-p-auto active' : 'ddz-p-auto';
  });
}

// ─── Hand rendering ───────────────────────────────────────
function renderDDZHand(cards) {
  const hand = document.getElementById('ddz-my-hand');
  if (!hand) return;
  if (!cards || !cards.length) {
    hand.innerHTML = '';
    return;
  }

  const sorted = [...cards].sort((a, b) => {
    const vo = VALUE_ORDER[b.value] - VALUE_ORDER[a.value];
    if (vo !== 0) return vo;
    return (SUIT_ORDER[a.suit] || 0) - (SUIT_ORDER[b.suit] || 0);
  });

  hand.innerHTML = sorted.map(c => {
    const key = `${c.suit}_${c.value}`;
    const sel = ddzSelectedKeys.has(key);
    return makeCardHTML(c, { key, cls: sel ? 'selected' : '' });
  }).join('');

  // Click handlers
  hand.querySelectorAll('.ddz-card').forEach(el => {
    el.addEventListener('click', () => {
      ddzCardSelectSound();
      const key = el.dataset.key;
      if (!key) return;
      if (ddzSelectedKeys.has(key)) {
        ddzSelectedKeys.delete(key);
      } else {
        ddzSelectedKeys.add(key);
      }
      renderDDZHand(ddzState ? ddzState.myCards : []);
    });
  });
}

// ─── Play / Pass ──────────────────────────────────────────
document.getElementById('ddz-play-btn').addEventListener('click', () => {
  ddzPlayCards();
});

document.getElementById('ddz-pass-btn').addEventListener('click', () => {
  ddzPass();
});

function ddzPlayCards() {
  if (!ddzState || !ddzState.myCards) return;
  const cards = ddzState.myCards.filter(c => ddzSelectedKeys.has(`${c.suit}_${c.value}`));
  if (!cards.length) return showModal('请选择要出的牌');
  ddzPlayCardSound();
  socket.emit('ddz:play-cards', { cards });
}

function ddzPass() {
  if (!ddzState) return;
  ddzPassSound();
  socket.emit('ddz:pass');
}

function ddzSendBid(bid) {
  ddzBidSound();
  socket.emit('ddz:bid', { bid });
}

function backToDDZRoom() {
  ddzState = null;
  ddzSelectedKeys = new Set();
  ddzAutoActive = false;
  ddzStopLocalTimer();
  socket.emit('ddz:back-to-room');
}

function leaveDDZGame() {
  ddzState = null;
  ddzSelectedKeys = new Set();
  ddzAutoActive = false;
  ddzStopLocalTimer();
  if (ddzMyRoom) {
    socket.emit('ddz:leave-room');
    ddzMyRoom = null;
  }
  showHall();
}
window.leaveDDZGame = leaveDDZGame;

// ═══════════════════════════════════════════════════════════
// SOUND
// ═══════════════════════════════════════════════════════════

let audioCtx = null;
function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
function note(f,dur,type='sine',vol=0.12) {
  if (!audioCtx) return;
  const o=audioCtx.createOscillator(),g=audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.type=type; o.frequency.setValueAtTime(f,audioCtx.currentTime);
  g.gain.setValueAtTime(vol,audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+dur);
  o.start(); o.stop(audioCtx.currentTime+dur);
}
function playEat() { note(660,0.08); setTimeout(()=>note(990,0.08),40); }
function playSprint() { note(500,0.1,'sine',0.06); }
function playGameStart() { [523,659,784].forEach((f,i)=>setTimeout(()=>note(f,0.2),i*100)); }
function playGameOver() { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>note(f,0.3),i*150)); }

// ─── Doudizhu Sound ─────────────────────────────────────────
function ddzNote(f, dur, type, vol) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f, audioCtx.currentTime);
  g.gain.setValueAtTime(vol || 0.1, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.start(); o.stop(audioCtx.currentTime + dur);
}

function ddzPlayCardSound() {
  ddzNote(800, 0.06, 'square', 0.04);
}

function ddzPassSound() {
  ddzNote(400, 0.12, 'sine', 0.06);
  setTimeout(() => ddzNote(300, 0.15, 'sine', 0.05), 80);
}

function ddzBidSound() {
  ddzNote(660, 0.1, 'sine', 0.06);
  setTimeout(() => ddzNote(880, 0.1, 'sine', 0.06), 80);
}

function ddzWinSound() {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => ddzNote(f, 0.25, 'sine', 0.08), i * 120));
}

function ddzLoseSound() {
  [400, 350, 300, 250].forEach((f, i) => setTimeout(() => ddzNote(f, 0.3, 'sine', 0.07), i * 150));
}

function ddzCardSelectSound() {
  ddzNote(1200, 0.03, 'square', 0.03);
}
document.addEventListener('click', initAudio, { once: true });
document.addEventListener('keydown', initAudio, { once: true });

// ═══════════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════════

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
window.showHall = showHall; // for inline onclick
