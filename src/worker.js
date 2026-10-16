// ══════════════════════════════════════════════════════════════════
//  COMBAT ZONE — Cloudflare Worker
//  Static files come from ./public (assets binding). This Worker handles
//  /api/rooms* and WebSocket upgrades. Each game room is a Durable Object;
//  a singleton "Lobby" Durable Object tracks the room list.
// ══════════════════════════════════════════════════════════════════
import { DurableObject } from 'cloudflare:workers';

const TILE_SIZE = 40;
const MAP_COLS  = 50;
const MAP_ROWS  = 50;
const WALL_DENSITY = 0.20;

const MAX_PLAYERS    = 8;
const MAX_PLAYERS_BR = 16;
const BR_CHEST_COUNT = 20;

const BR_ZONE_STAGES = [
  { radius: 1600, holdDuration: 80 },
  { radius: 900,  holdDuration: 70 },
  { radius: 400,  holdDuration: 60 },
  { radius: 0 },
];

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

function floorTiles(map) {
  const tiles = [];
  for (let row = 1; row < MAP_ROWS - 1; row++)
    for (let col = 1; col < MAP_COLS - 1; col++)
      if (map[row][col] === 0) tiles.push([col, row]);
  return tiles;
}

function randomSpawnPos(map) {
  const tiles = floorTiles(map);
  const [col, row] = tiles[Math.floor(Math.random() * tiles.length)];
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

function generateChests(map, count) {
  const floor = floorTiles(map);
  for (let i = floor.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [floor[i], floor[j]] = [floor[j], floor[i]];
  }
  return floor.slice(0, count).map(([col, row], id) => ({
    id,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    open: false,
  }));
}

const json = (obj, init) =>
  new Response(JSON.stringify(obj), { ...init, headers: { 'Content-Type': 'application/json' } });

// ── Worker entry ──────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));

    if (request.headers.get('Upgrade') === 'websocket') {
      const roomId = url.searchParams.get('room');
      if (!roomId) return new Response('Room not found', { status: 404 });
      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
    }

    if (url.pathname === '/api/rooms' || url.pathname === '/api/rooms/br') {
      return lobby.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Lobby: room registry ──────────────────────────────────────────
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.rooms = new Map(); // id → { id, players, maxPlayers, mode, phase }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      return json([...this.rooms.values()]);
    }

    if (request.method === 'POST' && (url.pathname === '/api/rooms' || url.pathname === '/api/rooms/br')) {
      const mode = url.pathname.endsWith('/br') ? 'br' : 'casual';
      let id;
      do {
        id = Array.from({ length: 4 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('');
      } while (this.rooms.has(id));

      const mapSeed = Math.floor(Math.random() * 1_000_000);
      this.rooms.set(id, {
        id, players: 0, mode,
        maxPlayers: mode === 'br' ? MAX_PLAYERS_BR : MAX_PLAYERS,
        phase: mode === 'br' ? 'lobby' : null,
      });
      await this.env.ROOM.get(this.env.ROOM.idFromName(id)).init(id, mode, mapSeed);
      return json({ id });
    }

    return new Response('Not found', { status: 404 });
  }

  // Called by Room DOs
  update(id, info) { if (this.rooms.has(id)) Object.assign(this.rooms.get(id), info); }
  remove(id)       { this.rooms.delete(id); }
}

// ── Room ──────────────────────────────────────────────────────────
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.room = null;
  }

  init(id, mode, mapSeed) {
    const room = {
      id, mode, mapSeed,
      map: generateMap(mapSeed),
      players: new Map(),
      nextId: 1,
    };
    if (mode === 'br') {
      Object.assign(room, {
        brPhase: 'lobby',
        brReady: new Set(),
        brChests: [],
        brZoneStage: 0,
        brZoneRadius: 1600,
        brAlivePlayers: new Set(),
        brLobbyTimer: setTimeout(() => this.startBrMatch(), 60000),
        brZoneTimer: null,
      });
    }
    this.room = room;
  }

  get lobby() { return this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')); }

  reportToLobby() {
    const r = this.room;
    this.lobby.update(r.id, { players: r.players.size, phase: r.mode === 'br' ? r.brPhase : null });
  }

  async fetch(request) {
    const room = this.room;
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();

    const reject = (reason) => { ws.close(1008, reason); return new Response(null, { status: 101, webSocket: client }); };

    if (!room) return reject('Room not found');
    if (room.mode === 'br' && room.brPhase !== 'lobby') return reject('Match already in progress');
    const maxPlayers = room.mode === 'br' ? MAX_PLAYERS_BR : MAX_PLAYERS;
    if (room.players.size >= maxPlayers) return reject('Room is full');

    const id = room.nextId++;
    const rawName = url.searchParams.get('name') ?? '';
    const name = rawName.trim().replace(/[<>&"]/g, '').slice(0, 20) || `Player ${id}`;
    const spawn = randomSpawnPos(room.map);
    const p = {
      id, ws, name,
      x: spawn.x, y: spawn.y,
      bodyAngle: 0, turretAngle: 0,
      health: 100, kills: 0, afk: false,
    };
    room.players.set(id, p);

    const init = {
      type: 'init', id, name, mapSeed: room.mapSeed,
      players: this.otherPlayersPublic(id),
    };
    if (room.mode === 'br') {
      init.brMode = true;
      init.brPhase = room.brPhase;
      init.brChests = room.brChests;
    }
    this.send(ws, init);
    this.broadcast({ type: 'joined', player: this.pub(p) }, id);
    if (room.mode === 'br') this.send(ws, { type: 'brReadyState', readyIds: [...room.brReady] });
    this.reportToLobby();

    ws.addEventListener('message', (ev) => this.onMessage(p, ev.data));
    const onClose = () => this.onClose(p);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(p, raw) {
    const room = this.room;
    const id = p.id;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'update':
        p.x           = msg.x           ?? p.x;
        p.y           = msg.y           ?? p.y;
        p.bodyAngle   = msg.bodyAngle   ?? p.bodyAngle;
        p.turretAngle = msg.turretAngle ?? p.turretAngle;
        this.broadcast({ type: 'snapshot', id, x: p.x, y: p.y,
          bodyAngle: p.bodyAngle, turretAngle: p.turretAngle }, id);
        break;

      case 'shoot':
        this.broadcast({ type: 'bulletSpawned', playerId: id, bullet: msg.bullet }, id);
        break;

      case 'afk':
        p.afk = !!msg.active;
        this.broadcast({ type: 'afkChanged', id, afk: p.afk }, id);
        break;

      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 200);
        if (!text) break;
        this.broadcastAll({ type: 'chatMessage', id, name: p.name, text });
        break;
      }

      case 'hit': {
        if (p.health <= 0) break;
        p.health = Math.max(0, p.health - Math.round(msg.damage || 0));
        this.broadcastAll({ type: 'damaged', id, health: p.health });

        if (p.health <= 0) {
          const killer = msg.killerId ? room.players.get(msg.killerId) : null;
          if (killer) killer.kills++;
          this.broadcastAll({ type: 'killed', id, killerId: msg.killerId ?? null });

          if (room.mode === 'br') {
            room.brAlivePlayers.delete(id);
            this.checkBrWin();
          } else {
            setTimeout(() => {
              if (!room.players.has(id)) return;
              const sp = randomSpawnPos(room.map);
              p.health = 100;
              p.x = sp.x;
              p.y = sp.y;
              this.broadcastAll({ type: 'respawned', id, x: p.x, y: p.y });
            }, 3000);
          }
        }
        break;
      }

      case 'splatter':
        this.broadcast({ type: 'splattered', id }, id);
        break;

      case 'frozen':
        this.broadcastAll({ type: 'playerFrozen', id: msg.targetId ?? id, shooterId: msg.shooterId ?? null });
        break;

      case 'paintHit':
        this.broadcastAll({ type: 'playerSplattered', id: msg.targetId ?? id });
        break;

      case 'brReady':
        if (room.mode !== 'br' || room.brPhase !== 'lobby') break;
        if (msg.ready) room.brReady.add(id);
        else           room.brReady.delete(id);
        this.broadcastAll({ type: 'brReadyState', readyIds: [...room.brReady] });
        if (room.brReady.size === room.players.size && room.players.size >= 2) this.startBrMatch();
        break;

      case 'brDrop': {
        if (room.mode !== 'br' || room.brPhase !== 'dropping') break;
        p.x = Math.max(TILE_SIZE, Math.min(MAP_COLS * TILE_SIZE - TILE_SIZE, msg.x ?? p.x));
        p.y = Math.max(TILE_SIZE, Math.min(MAP_ROWS * TILE_SIZE - TILE_SIZE, msg.y ?? p.y));
        this.broadcastAll({ type: 'brDropConfirmed', id, x: p.x, y: p.y });
        break;
      }

      case 'brStormDamage':
        if (room.mode !== 'br' || room.brPhase !== 'active') break;
        if (p.health <= 0) break;
        p.health = Math.max(0, p.health - Math.round(msg.damage || 0));
        this.broadcastAll({ type: 'damaged', id, health: p.health });
        if (p.health <= 0) {
          this.broadcastAll({ type: 'killed', id, killerId: null });
          room.brAlivePlayers.delete(id);
          this.checkBrWin();
        }
        break;

      case 'brChestOpen': {
        if (room.mode !== 'br' || room.brPhase !== 'active') break;
        const chest = room.brChests[msg.chestId];
        if (!chest || chest.open) break;
        if (Math.hypot(p.x - chest.x, p.y - chest.y) > 80) break;
        chest.open = true;
        const roll = Math.random();
        const lootType = roll < 0.50 ? 'ammo' : roll < 0.85 ? 'rare_ammo' : 'health';
        this.broadcastAll({ type: 'brChestOpened', chestId: chest.id, lootType });
        break;
      }
    }
  }

  onClose(p) {
    const room = this.room;
    if (!room || !room.players.delete(p.id)) return;
    room.brReady?.delete(p.id);
    this.broadcastAll({ type: 'left', id: p.id });

    if (room.mode === 'br') {
      room.brAlivePlayers.delete(p.id);
      this.checkBrWin();
    }

    if (room.players.size === 0) {
      clearTimeout(room.brLobbyTimer);
      clearTimeout(room.brZoneTimer);
      this.room = null;
      this.lobby.remove(room.id);
    } else {
      this.reportToLobby();
    }
  }

  // ── Battle Royale ───────────────────────────────────────────────
  startBrMatch() {
    const room = this.room;
    if (!room || room.brPhase !== 'lobby' || room.players.size < 2) return;
    clearTimeout(room.brLobbyTimer);

    room.brPhase = 'dropping';
    room.brChests = generateChests(room.map, BR_CHEST_COUNT);
    room.brAlivePlayers = new Set(room.players.keys());
    this.broadcastAll({ type: 'brPhaseChanged', phase: 'dropping', chests: room.brChests });
    this.reportToLobby();
    setTimeout(() => this.activateBrMatch(), 5000);
  }

  activateBrMatch() {
    const room = this.room;
    if (!room || room.brPhase !== 'dropping') return;
    room.brPhase = 'active';
    this.broadcastAll({ type: 'brPhaseChanged', phase: 'active' });
    this.reportToLobby();
    this.scheduleNextShrink(0);
  }

  scheduleNextShrink(stageIndex) {
    const room = this.room;
    const stage = BR_ZONE_STAGES[stageIndex];
    if (!stage || stage.holdDuration === undefined) return;

    room.brZoneTimer = setTimeout(() => {
      if (this.room !== room || room.brPhase !== 'active') return;
      const next = BR_ZONE_STAGES[stageIndex + 1];
      if (!next) return;
      room.brZoneStage = stageIndex + 1;
      room.brZoneRadius = next.radius;
      this.broadcastAll({ type: 'brZoneShrink', newRadius: next.radius, tweenDuration: 30 });
      this.scheduleNextShrink(stageIndex + 1);
    }, stage.holdDuration * 1000);
  }

  checkBrWin() {
    const room = this.room;
    if (!room || (room.brPhase !== 'active' && room.brPhase !== 'dropping')) return;
    if (room.brAlivePlayers.size !== 1) return;

    const winnerId = [...room.brAlivePlayers][0];
    const winner = room.players.get(winnerId);
    room.brPhase = 'ended';
    clearTimeout(room.brZoneTimer);
    this.broadcastAll({ type: 'brWinner', winnerId, winnerName: winner ? winner.name : 'Unknown' });
    this.reportToLobby();
    setTimeout(() => this.lobby.remove(room.id), 10000);
  }

  // ── Helpers ─────────────────────────────────────────────────────
  pub(p) { const { ws: _, ...rest } = p; return rest; }

  otherPlayersPublic(excludeId) {
    return [...this.room.players.values()].filter(p => p.id !== excludeId).map(p => this.pub(p));
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  broadcast(obj, excludeId) {
    const str = JSON.stringify(obj);
    for (const p of this.room.players.values())
      if (p.id !== excludeId) try { p.ws.send(str); } catch {}
  }

  broadcastAll(obj) {
    const str = JSON.stringify(obj);
    for (const p of this.room.players.values()) try { p.ws.send(str); } catch {}
  }
}
