const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const WIDTH = 960;
const HEIGHT = 640;
const PLAYER_RADIUS = 16;
const PLAYER_SPEED = 320;
const TAG_DISTANCE = PLAYER_RADIUS * 2 + 4;
const TAG_COOLDOWN_MS = 1200;
const PLAYER_TIMEOUT_MS = 15000;

const players = {};
let itId = null;
let lastTagAt = 0;
let lastTick = Date.now();
const recentEvents = [];

function nowMs() {
  return Date.now();
}

function pushEvent(type, message) {
  recentEvents.push({ at: nowMs(), type, message });
  while (recentEvents.length > 40) recentEvents.shift();
}

function countPlayers() {
  return Object.keys(players).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomSpawn() {
  const margin = PLAYER_RADIUS + 8;
  return {
    x: Math.random() * (WIDTH - margin * 2) + margin,
    y: Math.random() * (HEIGHT - margin * 2) + margin,
  };
}

function pickRandomPlayerId() {
  const ids = Object.keys(players);
  if (!ids.length) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Jugador';
  const trimmed = name.trim().slice(0, 20);
  return trimmed || 'Jugador';
}

function ensureValidIt() {
  if (!itId || !players[itId]) {
    itId = pickRandomPlayerId();
    lastTagAt = nowMs();
  }
}

function publicState() {
  return {
    width: WIDTH,
    height: HEIGHT,
    maxPlayers: MAX_PLAYERS,
    playerCount: countPlayers(),
    itId,
    players: Object.fromEntries(
      Object.entries(players).map(([id, p]) => [
        id,
        {
          id,
          name: p.name,
          x: p.x,
          y: p.y,
          radius: PLAYER_RADIUS,
          isIt: id === itId,
          notItTimeMs: p.notItTimeMs,
        },
      ])
    ),
    leaderboard: Object.values(players)
      .map((p) => ({ name: p.name, notItTimeMs: p.notItTimeMs }))
      .sort((a, b) => b.notItTimeMs - a.notItTimeMs)
      .slice(0, MAX_PLAYERS),
    events: recentEvents,
    serverTime: nowMs(),
  };
}

function createPlayer(name) {
  const id = crypto.randomBytes(12).toString('hex');
  const spawn = randomSpawn();
  players[id] = {
    id,
    name,
    x: spawn.x,
    y: spawn.y,
    input: { up: false, down: false, left: false, right: false },
    notItTimeMs: 0,
    lastSeenAt: nowMs(),
  };
  return id;
}

function removePlayer(playerId, reason = 'salió') {
  const p = players[playerId];
  if (!p) return;
  const wasIt = playerId === itId;
  const leftName = p.name;
  delete players[playerId];
  if (wasIt) itId = null;
  ensureValidIt();
  pushEvent('system', `${leftName} ${reason} (${countPlayers()}/${MAX_PLAYERS})`);
}

function updatePlayerMovement(dtSec) {
  for (const p of Object.values(players)) {
    let dx = 0;
    let dy = 0;

    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      p.x = clamp(p.x + dx * PLAYER_SPEED * dtSec, PLAYER_RADIUS, WIDTH - PLAYER_RADIUS);
      p.y = clamp(p.y + dy * PLAYER_SPEED * dtSec, PLAYER_RADIUS, HEIGHT - PLAYER_RADIUS);
    }
  }
}

function updateSurvivalTime(dtMs) {
  for (const [id, p] of Object.entries(players)) {
    if (id !== itId) p.notItTimeMs += dtMs;
  }
}

function tryTag() {
  if (!itId || !players[itId]) return;
  const now = nowMs();
  if (now - lastTagAt < TAG_COOLDOWN_MS) return;

  const itPlayer = players[itId];
  for (const [id, p] of Object.entries(players)) {
    if (id === itId) continue;
    const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);
    if (dist <= TAG_DISTANCE) {
      itId = id;
      lastTagAt = now;
      pushEvent('tag', `${itPlayer.name} tocó a ${p.name}. ¡La lleva cambia!`);
      break;
    }
  }
}

function purgeInactivePlayers() {
  const cutoff = nowMs() - PLAYER_TIMEOUT_MS;
  for (const p of Object.values(players)) {
    if (p.lastSeenAt < cutoff) {
      removePlayer(p.id, 'se desconectó');
    }
  }
}

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'No se pudo leer el archivo' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': content.length,
    });
    res.end(content);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 16) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && url.pathname === '/join') {
    try {
      const body = await readJsonBody(req);
      if (countPlayers() >= MAX_PLAYERS) {
        return sendJson(res, 403, { error: 'Sala llena (4/4).' });
      }
      const playerId = createPlayer(sanitizeName(body.name));
      ensureValidIt();
      pushEvent('system', `${players[playerId].name} se unió (${countPlayers()}/${MAX_PLAYERS})`);
      return sendJson(res, 200, { playerId, maxPlayers: MAX_PLAYERS });
    } catch (err) {
      return sendJson(res, 400, { error: `Solicitud inválida: ${err.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/input') {
    try {
      const body = await readJsonBody(req);
      const player = players[body.playerId];
      if (!player) return sendJson(res, 404, { error: 'Jugador no encontrado' });
      const input = body.input || {};
      player.input.up = Boolean(input.up);
      player.input.down = Boolean(input.down);
      player.input.left = Boolean(input.left);
      player.input.right = Boolean(input.right);
      player.lastSeenAt = nowMs();
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: `Solicitud inválida: ${err.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/leave') {
    try {
      const body = await readJsonBody(req);
      removePlayer(body.playerId, 'salió');
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: `Solicitud inválida: ${err.message}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    const playerId = url.searchParams.get('playerId') || '';
    const player = players[playerId];
    if (player) player.lastSeenAt = nowMs();
    return sendJson(res, 200, publicState());
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada' });
});

setInterval(() => {
  const current = nowMs();
  const dtMs = current - lastTick;
  lastTick = current;

  if (!countPlayers()) return;

  updatePlayerMovement(dtMs / 1000);
  updateSurvivalTime(dtMs);
  tryTag();
  purgeInactivePlayers();
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`TAG online corriendo en http://localhost:${PORT}`);
});
