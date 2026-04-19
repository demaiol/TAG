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
const ROOM_CODE_LEN = 6;
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 60;

/** @type {Record<string, {code: string, players: Record<string, any>, itId: string | null, lastTagAt: number, lastTick: number, recentEvents: Array<{at:number,type:string,message:string}>, gameDurationMs: number, startedAt: number, endedAt: number | null, winnerName: string | null}>} */
const rooms = {};
/** @type {Record<string, string>} */
const playerRoomById = {};

function nowMs() {
  return Date.now();
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Jugador';
  const trimmed = name.trim().slice(0, 20);
  return trimmed || 'Jugador';
}

function sanitizeRoomCode(code) {
  if (typeof code !== 'string') return '';
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function sanitizeDurationMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  return clamp(Math.round(parsed), MIN_DURATION_MIN, MAX_DURATION_MIN);
}

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateUniqueRoomCode() {
  for (let i = 0; i < 50; i += 1) {
    const code = randomRoomCode();
    if (!rooms[code]) return code;
  }
  return `${randomRoomCode()}${Math.floor(Math.random() * 9)}`;
}

function getRoom(code) {
  return rooms[code] || null;
}

function createRoom(roomCode, durationMinutes) {
  const code = sanitizeRoomCode(roomCode) || generateUniqueRoomCode();
  if (rooms[code]) return null;
  rooms[code] = {
    code,
    players: {},
    itId: null,
    lastTagAt: 0,
    lastTick: nowMs(),
    recentEvents: [],
    gameDurationMs: sanitizeDurationMinutes(durationMinutes) * 60 * 1000,
    startedAt: nowMs(),
    endedAt: null,
    winnerName: null,
  };
  return rooms[code];
}

function pushRoomEvent(room, type, message) {
  room.recentEvents.push({ at: nowMs(), type, message });
  while (room.recentEvents.length > 40) room.recentEvents.shift();
}

function roomPlayerCount(room) {
  return Object.keys(room.players).length;
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

function pickRandomPlayerId(room) {
  const ids = Object.keys(room.players);
  if (!ids.length) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

function ensureValidIt(room) {
  if (!room.itId || !room.players[room.itId]) {
    room.itId = pickRandomPlayerId(room);
    room.lastTagAt = nowMs();
  }
}

function roomRemainingMs(room) {
  if (room.endedAt) return 0;
  return Math.max(0, room.gameDurationMs - (nowMs() - room.startedAt));
}

function roomWinnerName(room) {
  const rows = Object.values(room.players).sort((a, b) => b.notItTimeMs - a.notItTimeMs);
  return rows.length ? rows[0].name : null;
}

function buildRoomState(room) {
  return {
    roomCode: room.code,
    width: WIDTH,
    height: HEIGHT,
    maxPlayers: MAX_PLAYERS,
    playerCount: roomPlayerCount(room),
    durationMinutes: Math.round(room.gameDurationMs / 60000),
    remainingMs: roomRemainingMs(room),
    gameEnded: Boolean(room.endedAt),
    winnerName: room.winnerName,
    itId: room.itId,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [
        id,
        {
          id,
          name: p.name,
          x: p.x,
          y: p.y,
          radius: PLAYER_RADIUS,
          isIt: id === room.itId,
          notItTimeMs: p.notItTimeMs,
        },
      ])
    ),
    leaderboard: Object.values(room.players)
      .map((p) => ({ name: p.name, notItTimeMs: p.notItTimeMs }))
      .sort((a, b) => b.notItTimeMs - a.notItTimeMs)
      .slice(0, MAX_PLAYERS),
    events: room.recentEvents,
    serverTime: nowMs(),
  };
}

function createPlayer(room, name) {
  const id = crypto.randomBytes(12).toString('hex');
  const spawn = randomSpawn();
  room.players[id] = {
    id,
    name,
    x: spawn.x,
    y: spawn.y,
    input: { up: false, down: false, left: false, right: false },
    notItTimeMs: 0,
    lastSeenAt: nowMs(),
  };
  playerRoomById[id] = room.code;
  return id;
}

function maybeDeleteRoom(room) {
  if (roomPlayerCount(room) === 0) {
    delete rooms[room.code];
  }
}

function removePlayer(playerId, reason = 'salió') {
  const roomCode = playerRoomById[playerId];
  if (!roomCode) return;
  const room = rooms[roomCode];
  if (!room) {
    delete playerRoomById[playerId];
    return;
  }

  const p = room.players[playerId];
  if (!p) {
    delete playerRoomById[playerId];
    maybeDeleteRoom(room);
    return;
  }

  const wasIt = playerId === room.itId;
  const leftName = p.name;

  delete room.players[playerId];
  delete playerRoomById[playerId];

  if (wasIt) room.itId = null;
  ensureValidIt(room);

  pushRoomEvent(room, 'system', `${leftName} ${reason} (${roomPlayerCount(room)}/${MAX_PLAYERS})`);
  maybeDeleteRoom(room);
}

function updateRoom(room) {
  const current = nowMs();
  const dtMs = current - room.lastTick;
  room.lastTick = current;

  if (!roomPlayerCount(room)) {
    return;
  }

  if (!room.endedAt && roomRemainingMs(room) <= 0) {
    room.endedAt = nowMs();
    room.winnerName = roomWinnerName(room);
    pushRoomEvent(
      room,
      'system',
      room.winnerName
        ? `Fin de partida. Ganó ${room.winnerName}.`
        : 'Fin de partida. No hubo ganador.'
    );
  }

  if (room.endedAt) {
    const cutoffEnded = nowMs() - PLAYER_TIMEOUT_MS;
    for (const p of Object.values(room.players)) {
      if (p.lastSeenAt < cutoffEnded) {
        removePlayer(p.id, 'se desconectó');
      }
    }
    return;
  }

  const dtSec = dtMs / 1000;

  for (const p of Object.values(room.players)) {
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

  for (const [id, p] of Object.entries(room.players)) {
    if (id !== room.itId) p.notItTimeMs += dtMs;
  }

  if (room.itId && room.players[room.itId]) {
    const now = nowMs();
    if (now - room.lastTagAt >= TAG_COOLDOWN_MS) {
      const itPlayer = room.players[room.itId];
      for (const [id, p] of Object.entries(room.players)) {
        if (id === room.itId) continue;
        const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);
        if (dist <= TAG_DISTANCE) {
          room.itId = id;
          room.lastTagAt = now;
          pushRoomEvent(room, 'tag', `${itPlayer.name} tocó a ${p.name}. ¡La lleva cambia!`);
          break;
        }
      }
    }
  }

  const cutoff = nowMs() - PLAYER_TIMEOUT_MS;
  for (const p of Object.values(room.players)) {
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
      const name = sanitizeName(body.name);
      const requestedCode = sanitizeRoomCode(body.roomCode);
      const create = Boolean(body.create);
      const durationMinutes = sanitizeDurationMinutes(body.durationMinutes);

      let room = null;

      if (create) {
        if (requestedCode && rooms[requestedCode]) {
          return sendJson(res, 409, { error: 'Ese código de sala ya existe.' });
        }
        room = createRoom(requestedCode || generateUniqueRoomCode(), durationMinutes);
      } else {
        if (!requestedCode) {
          return sendJson(res, 400, { error: 'Debes ingresar un código de sala.' });
        }
        room = getRoom(requestedCode);
        if (!room) {
          return sendJson(res, 404, { error: 'La sala no existe.' });
        }
        if (room.endedAt) {
          return sendJson(res, 403, { error: 'Esa partida ya terminó. Crea otra sala.' });
        }
      }

      if (!room) {
        return sendJson(res, 500, { error: 'No se pudo crear/encontrar la sala.' });
      }

      if (roomPlayerCount(room) >= MAX_PLAYERS) {
        return sendJson(res, 403, { error: `Sala ${room.code} llena (4/4).` });
      }

      const playerId = createPlayer(room, name);
      ensureValidIt(room);
      pushRoomEvent(room, 'system', `${room.players[playerId].name} se unió (${roomPlayerCount(room)}/${MAX_PLAYERS})`);

      return sendJson(res, 200, {
        playerId,
        roomCode: room.code,
        maxPlayers: MAX_PLAYERS,
        durationMinutes: Math.round(room.gameDurationMs / 60000),
      });
    } catch (err) {
      return sendJson(res, 400, { error: `Solicitud inválida: ${err.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/input') {
    try {
      const body = await readJsonBody(req);
      const roomCode = playerRoomById[body.playerId];
      const room = roomCode ? rooms[roomCode] : null;
      const player = room ? room.players[body.playerId] : null;
      if (!player) return sendJson(res, 404, { error: 'Jugador no encontrado' });

      const input = body.input || {};
      if (room.endedAt) return sendJson(res, 200, { ok: true, ended: true });
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
    const roomCode = playerRoomById[playerId];
    const room = roomCode ? rooms[roomCode] : null;

    if (!room) {
      return sendJson(res, 200, {
        roomCode: null,
        width: WIDTH,
        height: HEIGHT,
        maxPlayers: MAX_PLAYERS,
        playerCount: 0,
        durationMinutes: 0,
        remainingMs: 0,
        gameEnded: false,
        winnerName: null,
        itId: null,
        players: {},
        leaderboard: [],
        events: [],
        serverTime: nowMs(),
      });
    }

    const player = room.players[playerId];
    if (player) player.lastSeenAt = nowMs();

    return sendJson(res, 200, buildRoomState(room));
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada' });
});

setInterval(() => {
  for (const room of Object.values(rooms)) {
    updateRoom(room);
  }
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`TAG online corriendo en http://localhost:${PORT}`);
});
