// ══════════════════════════════════════════════════════════════════
//  COMBAT ZONE — Server  (room-aware)
//
//  Install:  npm install
//  Run:      node server.js
//  Lobby:    http://localhost:3000          (index.html)
//  Game:     http://localhost:3000/game     (game.html)
// ══════════════════════════════════════════════════════════════════
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Shared constants (must match game.html) ───────────────────────
const TILE_SIZE = 40;
const MAP_COLS  = 50;
const MAP_ROWS  = 50;

const WALL_DENSITY = 0.20;

function makeRng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generateMap(seed) {
  const rng = makeRng(seed);
  const map = [];
  for (let row = 0; row < MAP_ROWS; row++) {
    map[row] = [];
    for (let col = 0; col < MAP_COLS; col++) {
      const isBorder = row === 0 || row === MAP_ROWS - 1 || col === 0 || col === MAP_COLS - 1;
      map[row][col] = isBorder ? 1 : (rng() < WALL_DENSITY ? 1 : 0);
    }
  }
  const mr = Math.floor(MAP_ROWS / 2), mc = Math.floor(MAP_COLS / 2);
  for (let r = mr - 2; r <= mr + 2; r++)
    for (let c = mc - 2; c <= mc + 2; c++)
      map[r][c] = 0;
  return map;
}

function randomSpawnPos(map) {
  const floorTiles = [];
  for (let row = 1; row < MAP_ROWS - 1; row++)
    for (let col = 1; col < MAP_COLS - 1; col++)
      if (map[row][col] === 0) floorTiles.push([col, row]);
  const [col, row] = floorTiles[Math.floor(Math.random() * floorTiles.length)];
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

// Max players per room
const MAX_PLAYERS    = 8;
const MAX_PLAYERS_BR = 16;
const BR_CHEST_COUNT = 20;

// Zone shrink stages: hold at each radius for holdDuration seconds, then tween to next
const BR_ZONE_STAGES = [
  { radius: 1600, holdDuration: 80 },
  { radius: 900,  holdDuration: 70 },
  { radius: 400,  holdDuration: 60 },
  { radius: 0 },  // sentinel
];

// ── Room storage ──────────────────────────────────────────────────
const rooms = new Map();

// ── Room ID generation ────────────────────────────────────────────
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: 4 }, () =>
      ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
    ).join('');
  } while (rooms.has(id));
  return id;
}

// ── BR helpers ────────────────────────────────────────────────────

function generateChests(map, count) {
  const floor = [];
  for (let row = 1; row < MAP_ROWS - 1; row++)
    for (let col = 1; col < MAP_COLS - 1; col++)
      if (map[row][col] === 0) floor.push([col, row]);
  // Fisher-Yates shuffle
  for (let i = floor.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [floor[i], floor[j]] = [floor[j], floor[i]];
  }
  return floor.slice(0, count).map(([ col, row ], id) => ({
    id,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    open: false,
  }));
}

function startBrMatch(room) {
  if (room.brPhase !== 'lobby') return;
  if (room.players.size < 2) return;
  if (room.brLobbyTimer) { clearTimeout(room.brLobbyTimer); room.brLobbyTimer = null; }

  room.brPhase  = 'dropping';
  room.brChests = generateChests(room.map, BR_CHEST_COUNT);
  room.brAlivePlayers = new Set(room.players.keys());

  broadcastRoomAll(room, { type: 'brPhaseChanged', phase: 'dropping', chests: room.brChests });

  setTimeout(() => activateBrMatch(room), 5000);
}

function activateBrMatch(room) {
  if (room.brPhase !== 'dropping') return;
  room.brPhase = 'active';
  broadcastRoomAll(room, { type: 'brPhaseChanged', phase: 'active' });
  scheduleNextShrink(room, 0);
}

function scheduleNextShrink(room, stageIndex) {
  const stage = BR_ZONE_STAGES[stageIndex];
  if (!stage || stage.holdDuration === undefined) return;

  room.brZoneTimer = setTimeout(() => {
    if (room.brPhase !== 'active') return;
    const nextStage = BR_ZONE_STAGES[stageIndex + 1];
    if (!nextStage) return;
    room.brZoneStage  = stageIndex + 1;
    room.brZoneRadius = nextStage.radius;
    broadcastRoomAll(room, {
      type:         'brZoneShrink',
      newRadius:    nextStage.radius,
      tweenDuration: 30,
    });
    scheduleNextShrink(room, stageIndex + 1);
  }, stage.holdDuration * 1000);
}

function checkBrWin(room) {
  if (room.brPhase !== 'active' && room.brPhase !== 'dropping') return;
  if (room.brAlivePlayers.size !== 1) return;

  const winnerId = [...room.brAlivePlayers][0];
  const winner   = room.players.get(winnerId);
  room.brPhase   = 'ended';
  if (room.brZoneTimer) clearTimeout(room.brZoneTimer);

  broadcastRoomAll(room, {
    type:       'brWinner',
    winnerId,
    winnerName: winner ? winner.name : 'Unknown',
  });

  setTimeout(() => {
    rooms.delete(room.id);
    console.log(`[room] BR room ${room.id} ended and deleted`);
  }, 10000);
}

// ── HTTP server ───────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost`);
  const path_ = url.pathname;

  // GET /api/rooms → list of active rooms
  if (req.method === 'GET' && path_ === '/api/rooms') {
    const list = Array.from(rooms.values()).map(r => ({
      id:         r.id,
      players:    r.players.size,
      maxPlayers: r.mode === 'br' ? MAX_PLAYERS_BR : MAX_PLAYERS,
      mode:       r.mode ?? 'casual',
      phase:      r.brPhase ?? null,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/rooms → create a new casual room, return { id }
  if (req.method === 'POST' && path_ === '/api/rooms') {
    const id      = generateRoomId();
    const mapSeed = Math.floor(Math.random() * 1_000_000);
    rooms.set(id, {
      id,
      players: new Map(),
      nextId:  1,
      mapSeed,
      map: generateMap(mapSeed),
      mode: 'casual',
    });
    console.log(`[room] Created casual room ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  // POST /api/rooms/br → create a BR room, return { id }
  if (req.method === 'POST' && path_ === '/api/rooms/br') {
    const id      = generateRoomId();
    const mapSeed = Math.floor(Math.random() * 1_000_000);
    const map     = generateMap(mapSeed);

    const room = {
      id,
      players: new Map(),
      nextId:  1,
      mapSeed,
      map,
      mode:           'br',
      brPhase:        'lobby',
      brReady:        new Set(),
      brChests:       [],
      brZoneStage:    0,
      brZoneRadius:   1600,
      brAlivePlayers: new Set(),
      brLobbyTimer:   null,
      brZoneTimer:    null,
    };
    // brLobbyTimer refs the room so we assign after creation
    room.brLobbyTimer = setTimeout(() => startBrMatch(room), 60000);
    rooms.set(id, room);
    console.log(`[room] Created BR room ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  // GET /game → serve game.html
  if (req.method === 'GET' && path_ === '/game') {
    const file = path.join(__dirname, 'game.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // GET / → serve index.html (lobby)
  if (req.method === 'GET' && path_ === '/') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // GET /assets/* → serve static assets
  if (req.method === 'GET' && path_.startsWith('/assets/')) {
    const safeName = path.basename(path_);
    const file = path.join(__dirname, 'assets', safeName);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(safeName).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');

  if (!roomId || !rooms.has(roomId)) {
    ws.close(1008, 'Room not found');
    return;
  }

  const room = rooms.get(roomId);

  // BR rooms block late joiners once the match has started
  if (room.mode === 'br' && room.brPhase !== 'lobby') {
    ws.close(1008, 'Match already in progress');
    return;
  }

  const maxPlayers = room.mode === 'br' ? MAX_PLAYERS_BR : MAX_PLAYERS;
  if (room.players.size >= maxPlayers) {
    ws.close(1008, 'Room is full');
    return;
  }

  const id      = room.nextId++;
  const rawName = url.searchParams.get('name') ?? '';
  const name    = rawName.trim().replace(/[<>&"]/g, '').slice(0, 20) || `Player ${id}`;

  const spawn = randomSpawnPos(room.map);
  const p = {
    id, ws, name,
    x: spawn.x, y: spawn.y,
    bodyAngle: 0, turretAngle: 0,
    health: 100, kills: 0, afk: false,
  };
  room.players.set(id, p);

  // Build init payload; include BR state for BR rooms
  const initPayload = {
    type:    'init',
    id,
    name,
    mapSeed: room.mapSeed,
    players: otherPlayersPublic(room, id),
  };
  if (room.mode === 'br') {
    initPayload.brMode   = true;
    initPayload.brPhase  = room.brPhase;
    initPayload.brChests = room.brChests;
  }
  send(ws, initPayload);

  broadcastRoom(room, { type: 'joined', player: pub(p) }, id);

  // Send current ready list to the newcomer
  if (room.mode === 'br') {
    send(ws, { type: 'brReadyState', readyIds: [...room.brReady] });
  }

  console.log(`[+] ${name} joined ${room.mode} room ${roomId}  (${room.players.size}/${maxPlayers})`);

  // ── Handle messages from this client ────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'update':
        p.x           = msg.x           ?? p.x;
        p.y           = msg.y           ?? p.y;
        p.bodyAngle   = msg.bodyAngle   ?? p.bodyAngle;
        p.turretAngle = msg.turretAngle ?? p.turretAngle;
        broadcastRoom(
          room,
          { type: 'snapshot', id, x: p.x, y: p.y,
            bodyAngle: p.bodyAngle, turretAngle: p.turretAngle },
          id
        );
        break;

      case 'shoot':
        broadcastRoom(room, { type: 'bulletSpawned', playerId: id, bullet: msg.bullet }, id);
        break;

      case 'afk':
        p.afk = !!msg.active;
        broadcastRoom(room, { type: 'afkChanged', id, afk: p.afk }, id);
        break;

      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 200);
        if (!text) break;
        broadcastRoomAll(room, { type: 'chatMessage', id, name: p.name, text });
        break;
      }

      case 'hit': {
        if (p.health <= 0) break;

        p.health = Math.max(0, p.health - Math.round(msg.damage || 0));
        broadcastRoomAll(room, { type: 'damaged', id, health: p.health });

        if (p.health <= 0) {
          const killer = msg.killerId ? room.players.get(msg.killerId) : null;
          if (killer) killer.kills++;
          broadcastRoomAll(room, { type: 'killed', id, killerId: msg.killerId ?? null });

          if (room.mode === 'br') {
            // No respawn in BR
            room.brAlivePlayers.delete(id);
            checkBrWin(room);
          } else {
            setTimeout(() => {
              if (!room.players.has(id)) return;
              const sp = randomSpawnPos(room.map);
              p.health = 100;
              p.x = sp.x;
              p.y = sp.y;
              broadcastRoomAll(room, { type: 'respawned', id, x: p.x, y: p.y });
            }, 3000);
          }
        }
        break;
      }

      case 'splatter':
        broadcastRoom(room, { type: 'splattered', id }, id);
        break;

      case 'frozen':
        broadcastRoomAll(room, { type: 'playerFrozen', id: msg.targetId ?? id, shooterId: msg.shooterId ?? null });
        break;

      case 'paintHit':
        broadcastRoomAll(room, { type: 'playerSplattered', id: msg.targetId ?? id });
        break;

      // ── Battle Royale messages ────────────────────────────────

      case 'brReady': {
        if (room.mode !== 'br' || room.brPhase !== 'lobby') break;
        if (msg.ready) room.brReady.add(id);
        else           room.brReady.delete(id);
        broadcastRoomAll(room, { type: 'brReadyState', readyIds: [...room.brReady] });
        if (room.brReady.size === room.players.size && room.players.size >= 2) {
          startBrMatch(room);
        }
        break;
      }

      case 'brDrop': {
        if (room.mode !== 'br' || room.brPhase !== 'dropping') break;
        const dx = Math.max(TILE_SIZE, Math.min(MAP_COLS * TILE_SIZE - TILE_SIZE, msg.x ?? p.x));
        const dy = Math.max(TILE_SIZE, Math.min(MAP_ROWS * TILE_SIZE - TILE_SIZE, msg.y ?? p.y));
        p.x = dx; p.y = dy;
        broadcastRoomAll(room, { type: 'brDropConfirmed', id, x: p.x, y: p.y });
        break;
      }

      case 'brStormDamage': {
        if (room.mode !== 'br' || room.brPhase !== 'active') break;
        if (p.health <= 0) break;
        p.health = Math.max(0, p.health - Math.round(msg.damage || 0));
        broadcastRoomAll(room, { type: 'damaged', id, health: p.health });
        if (p.health <= 0) {
          broadcastRoomAll(room, { type: 'killed', id, killerId: null });
          room.brAlivePlayers.delete(id);
          checkBrWin(room);
        }
        break;
      }

      case 'brChestOpen': {
        if (room.mode !== 'br' || room.brPhase !== 'active') break;
        const chest = room.brChests[msg.chestId];
        if (!chest || chest.open) break;
        const ddx = p.x - chest.x, ddy = p.y - chest.y;
        if (Math.sqrt(ddx*ddx + ddy*ddy) > 80) break; // must be nearby
        chest.open = true;
        const roll = Math.random();
        const lootType = roll < 0.50 ? 'ammo' : roll < 0.85 ? 'rare_ammo' : 'health';
        broadcastRoomAll(room, { type: 'brChestOpened', chestId: chest.id, lootType });
        break;
      }
    }
  });

  ws.on('close', () => {
    room.players.delete(id);
    room.brReady?.delete(id);
    broadcastRoomAll(room, { type: 'left', id });
    console.log(`[-] ${name} left room ${roomId}  (${room.players.size} in room)`);

    if (room.mode === 'br') {
      room.brAlivePlayers.delete(id);
      checkBrWin(room);
    }

    if (room.players.size === 0) {
      if (room.brLobbyTimer) clearTimeout(room.brLobbyTimer);
      if (room.brZoneTimer)  clearTimeout(room.brZoneTimer);
      rooms.delete(roomId);
      console.log(`[room] Room ${roomId} deleted (empty)`);
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function pub(p) {
  const { ws: _, ...rest } = p;
  return rest;
}

function otherPlayersPublic(room, excludeId) {
  return Array.from(room.players.values())
    .filter(p => p.id !== excludeId)
    .map(pub);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, excludeId) {
  const str = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== excludeId && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(str);
    }
  }
}

function broadcastRoomAll(room, obj) {
  const str = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(str);
  }
}

// ── Start ─────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\nCombat Zone server → http://localhost:${PORT}\n`);
});
