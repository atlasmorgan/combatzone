# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the game

```bash
npm install     # first time only
npm start       # starts Node on http://localhost:3000
```

No build step. Pure ES6 client-side scripts served directly by Node. Open `http://localhost:3000` for the lobby, which links to `game.html`.

## Architecture

The project is a real-time multiplayer top-down tank game with three main files:

**`server.js`** — Node.js HTTP + WebSocket server (~300 lines)
- Serves all static files (index.html, game.html, assets/)
- REST: `GET /api/rooms`, `POST /api/rooms`
- WebSocket: relays messages between players in the same room; handles hit/kill/respawn logic server-side
- Rooms are in-memory `Map`; deleted when empty. Max 8 players per room.
- Player health and respawn (3s timeout) are managed here. Damage is client-reported and trusted.

**`index.html`** — Lobby (~430 lines)
- Firebase anonymous auth + Firestore sync (collection: `players`, keyed by `user.uid`)
- `loadStats()` / `saveStats()` read/write `localStorage` key `czCareerStats`
- Firestore is a backup; local storage is source of truth (merge-max on sync)
- Battle Shop: `SHOP_WEAPONS` array, `buyGun(id, cost)` deducts BB and appends to `ownedGuns`

**`game.html`** — Game client (~1,870 lines, single file)
- `update(dt)` → `draw()` via `requestAnimationFrame`
- `netSend(obj)` — fire-and-forget JSON over WebSocket
- `handleCommand(raw)` — parses `/cmd args` from the chat input; add new slash commands here
- `loadStats()` / `saveStats(delta)` — same localStorage helpers duplicated from index.html
- `syncToFirebase(user)` — call after mutating battleBucks or ownedGuns to persist to cloud

## Key patterns

**Adding a slash command:** Find `handleCommand()` in game.html (~line 738). Parse with `raw.slice(1).trim().split(/\s+/)`. Give feedback via `appendChatMessage('System', '...')`.

**Adding a weapon:** Add entry to `WEAPONS` const (~line 138), add ammo entries in player object and `spawnPlayer()`, add to `WEAPON_ORDER` and `WEAPON_ABBR`, add shop entry in `index.html` `SHOP_WEAPONS` array.

**Sounds:** Each sound is `new Audio('assets/file.mp3')`. One-shot sounds use `cloneNode()` + `play()`. Looping sounds (flame) manage `.play()` / `.pause()` directly from `fireBullet()` and the update loop.

**Damage model:** Victims detect their own hits from `remoteBullets` and call `netSend({ type: 'hit', damage, bulletId, killerId })`. Server applies `Math.round(damage)` to health.

**Mobile UI:** `drawWeaponSwitcher()` populates `weaponBtnRects[]` each frame; `touchstart` checks this array first before joystick/aim logic.
