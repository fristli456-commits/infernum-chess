const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP server (serves the HTML file) ──
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/ping') {
    // Keep-alive endpoint for Render (prevents sleep)
    res.writeHead(200);
    res.end('pong');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket server ──
const wss = new WebSocket.Server({ server });

// rooms: { code: { white: ws, black: ws, state: {...} } }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateCode() : code;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOpponent(room, ws) {
  if (room.white === ws) return room.black;
  if (room.black === ws) return room.white;
  return null;
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── CREATE ROOM ──
      case 'create': {
        const code = generateCode();
        const color = msg.color === 'black' ? 'black'
                    : msg.color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black')
                    : 'white';
        rooms[code] = {
          white: color === 'white' ? ws : null,
          black: color === 'black' ? ws : null,
          state: null,
          name: msg.name || 'Игрок'
        };
        ws.roomCode = code;
        ws.color = color;
        ws.playerName = msg.name || 'Игрок';
        send(ws, { type: 'created', code, color });
        console.log(`Room ${code} created by ${ws.playerName} as ${color}`);
        break;
      }

      // ── JOIN ROOM ──
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms[code];
        if (!room) { send(ws, { type: 'error', msg: 'Комната не найдена' }); return; }
        if (room.white && room.black) { send(ws, { type: 'error', msg: 'Комната заполнена' }); return; }

        const color = room.white ? 'black' : 'white';
        room[color] = ws;
        ws.roomCode = code;
        ws.color = color;
        ws.playerName = msg.name || 'Гость';

        // Notify both players: game starts
        const whiteInfo = { name: room.white === ws ? ws.playerName : room.name, color: 'white' };
        const blackInfo = { name: room.black === ws ? ws.playerName : room.name, color: 'black' };

        send(room.white, { type: 'start', yourColor: 'white', opponent: blackInfo.name });
        send(room.black, { type: 'start', yourColor: 'black', opponent: whiteInfo.name });
        console.log(`Room ${code}: ${whiteInfo.name} vs ${blackInfo.name}`);
        break;
      }

      // ── MOVE ──
      case 'move': {
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        // Forward move to opponent
        send(opp, { type: 'move', from: msg.from, to: msg.to, promo: msg.promo });
        break;
      }

      // ── RESIGN ──
      case 'resign': {
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, { type: 'opponent_resigned' });
        break;
      }

      // ── CHAT ──
      case 'chat': {
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, { type: 'chat', msg: (msg.msg || '').slice(0, 200), from: ws.playerName });
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const opp = getOpponent(room, ws);
    send(opp, { type: 'opponent_left' });
    // Clean up room after delay
    setTimeout(() => {
      if (rooms[code] && !rooms[code].white?.readyState === WebSocket.OPEN
          && !rooms[code].black?.readyState === WebSocket.OPEN) {
        delete rooms[code];
        console.log(`Room ${code} deleted`);
      }
    }, 30000);
  });
});

server.listen(PORT, () => {
  console.log(`INFERNUM server running on port ${PORT}`);
});

// ── Keep-alive self-ping (prevents Render free tier sleep) ──
// Render free tier sleeps after 15 min of no requests.
// We ping ourselves every 14 minutes.
const APP_URL = process.env.RENDER_EXTERNAL_URL;
if (APP_URL) {
  setInterval(() => {
    http.get(`${APP_URL}/ping`, (res) => {
      console.log(`Self-ping: ${res.statusCode}`);
    }).on('error', (e) => {
      console.log(`Self-ping failed: ${e.message}`);
    });
  }, 14 * 60 * 1000); // every 14 minutes
}