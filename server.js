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
const MAX_PLAYERS = 8;

// ── Room storage ──────────────────────────────────────────────────
// Key = room ID string (e.g. "AB3K"), value = room object:
//   { id, players: Map<numericId, playerState>, nextId, mapSeed }
const rooms = new Map();

// ── Room ID generation ────────────────────────────────────────────
// Characters chosen to avoid visually ambiguous chars (I, O, 1, 0)
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id;
  // Keep generating until we find one not already in use
  do {
    id = Array.from({ length: 4 }, () =>
      ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
    ).join('');
  } while (rooms.has(id));
  return id;
}

// ── HTTP server ───────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Parse URL (ignore query string for routing)
  const url  = new URL(req.url, `http://localhost`);
  const path_ = url.pathname;

  // ── REST API ────────────────────────────────────────────────────

  // GET /api/rooms → list of active rooms
  if (req.method === 'GET' && path_ === '/api/rooms') {
    const list = Array.from(rooms.values()).map(r => ({
      id:         r.id,
      players:    r.players.size,
      maxPlayers: MAX_PLAYERS,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/rooms → create a new room, return { id }
  if (req.method === 'POST' && path_ === '/api/rooms') {
    const id      = generateRoomId();
    const mapSeed = Math.floor(Math.random() * 1_000_000);
    rooms.set(id, {
      id,
      players: new Map(),
      nextId:  1,
      mapSeed,
      map: generateMap(mapSeed),
    });
    console.log(`[room] Created room ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  // ── Static file routes ──────────────────────────────────────────

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

  // Anything else → 404
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server — piggybacking on the same port via HTTP upgrade
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Parse the room ID from the query string: ws://host/?room=XXXX
  const url    = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');

  // Validate room exists
  if (!roomId || !rooms.has(roomId)) {
    ws.close(1008, 'Room not found');
    return;
  }

  const room = rooms.get(roomId);

  // Validate room not full
  if (room.players.size >= MAX_PLAYERS) {
    ws.close(1008, 'Room is full');
    return;
  }

  // Assign this player an ID scoped to the room
  const id       = room.nextId++;
  const rawName  = url.searchParams.get('name') ?? '';
  const name     = rawName.trim().replace(/[<>&"]/g, '').slice(0, 20) || `Player ${id}`;

  // Build this player's server-side state (ws field is stripped before broadcast)
  const spawn = randomSpawnPos(room.map);
  const p = {
    id, ws, name,
    x: spawn.x, y: spawn.y,
    bodyAngle: 0, turretAngle: 0,
    health: 100, kills: 0, afk: false,
  };
  room.players.set(id, p);

  // Send the newcomer their ID, the map seed, and the existing player list
  send(ws, {
    type:    'init',
    id,
    name,
    mapSeed: room.mapSeed,
    players: otherPlayersPublic(room, id),
  });

  // Tell everyone else in the same room that a new player joined
  broadcastRoom(room, { type: 'joined', player: pub(p) }, id);

  console.log(`[+] ${name} joined room ${roomId}  (${room.players.size} in room)`);

  // ── Handle messages from this client ────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; } // ignore malformed JSON

    switch (msg.type) {

      // Position / angle update — relay to everyone else in the room
      case 'update':
        p.x           = msg.x           ?? p.x;
        p.y           = msg.y           ?? p.y;
        p.bodyAngle   = msg.bodyAngle   ?? p.bodyAngle;
        p.turretAngle = msg.turretAngle ?? p.turretAngle;
        broadcastRoom(
          room,
          { type: 'snapshot', id, x: p.x, y: p.y,
            bodyAngle: p.bodyAngle, turretAngle: p.turretAngle },
          id  // don't echo back to sender
        );
        break;

      // Player fired a bullet — relay to everyone else in the room
      case 'shoot':
        broadcastRoom(room, { type: 'bulletSpawned', playerId: id, bullet: msg.bullet }, id);
        break;

      // AFK toggle — relay state to everyone else in the room
      case 'afk':
        p.afk = !!msg.active;
        broadcastRoom(room, { type: 'afkChanged', id, afk: p.afk }, id);
        break;

      // Chat message — broadcast to everyone in the room including sender
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 200);
        if (!text) break;
        broadcastRoomAll(room, { type: 'chatMessage', id, name: p.name, text });
        break;
      }

      // Client-side hit detection: this player reports they were hit.
      // The client sends the shooter's ID so we can credit the kill.
      case 'hit': {
        if (p.health <= 0) break; // already dead — ignore duplicate hits

        p.health = Math.max(0, p.health - (msg.damage || 0));

        // Broadcast the new health to all players in the room
        broadcastRoomAll(room, { type: 'damaged', id, health: p.health });

        if (p.health <= 0) {
          // Credit the kill to the shooter if they're still in this room
          const killer = msg.killerId ? room.players.get(msg.killerId) : null;
          if (killer) killer.kills++;
          broadcastRoomAll(room, { type: 'killed', id, killerId: msg.killerId ?? null });

          // Respawn this player after 3 seconds
          setTimeout(() => {
            if (!room.players.has(id)) return; // they disconnected before respawn
            const sp = randomSpawnPos(room.map);
            p.health = 100;
            p.x = sp.x;
            p.y = sp.y;
            broadcastRoomAll(room, { type: 'respawned', id, x: p.x, y: p.y });
          }, 3000);
        }
        break;
      }

      // Paintball special: relay to all other players in the room
      case 'splatter':
        broadcastRoom(room, { type: 'splattered', id }, id);
        break;

      // Permafrost special: relay freeze to ALL players (including victim who sent it)
      case 'frozen':
        broadcastRoomAll(room, { type: 'playerFrozen', id: msg.targetId ?? id, shooterId: msg.shooterId ?? null });
        break;
    }
  });

  ws.on('close', () => {
    room.players.delete(id);
    broadcastRoomAll(room, { type: 'left', id });
    console.log(`[-] ${name} left room ${roomId}  (${room.players.size} in room)`);

    // Delete the room when the last player leaves
    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`[room] Room ${roomId} deleted (empty)`);
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────

// Strip the WebSocket from a player before JSON-serialising it
function pub(p) {
  const { ws: _, ...rest } = p;
  return rest;
}

// Current players in a room (public state), excluding the given id
function otherPlayersPublic(room, excludeId) {
  return Array.from(room.players.values())
    .filter(p => p.id !== excludeId)
    .map(pub);
}

// Send to one WebSocket
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Send to everyone in a room except one player
function broadcastRoom(room, obj, excludeId) {
  const str = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== excludeId && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(str);
    }
  }
}

// Send to every player in a room, no exceptions
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
