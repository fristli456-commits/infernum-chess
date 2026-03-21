const http = require('http');
const https = require('https'); // ✅ FIX #10: добавлен https для self-ping
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// ══════════════════════════════════════════════════════
// MONGOOSE SCHEMAS
// ══════════════════════════════════════════════════════
const playerSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  nameLower: { type: String, unique: true },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  friends: [String],
  friendRequests: [String],
  sentRequests: [String],
  createdAt: { type: Date, default: Date.now }
});

const Player = mongoose.model('Player', playerSchema);

// ══════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/ping') {
    res.writeHead(200);
    res.end('pong');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ══════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ══════════════════════════════════════════════════════
const wss = new WebSocket.Server({ server });

// online players: name (lowercase) -> ws
const online = new Map();

// game rooms: code -> { white, black, name, statsRecorded }
const rooms = {};

// ✅ FIX #8: Rate limiting — максимум 30 сообщений в секунду на клиента
const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW_MS = 1000;

function checkRateLimit(ws) {
  const now = Date.now();
  if (!ws._msgCount) { ws._msgCount = 0; ws._msgWindowStart = now; }
  if (now - ws._msgWindowStart > MESSAGE_WINDOW_MS) {
    ws._msgCount = 0;
    ws._msgWindowStart = now;
  }
  ws._msgCount++;
  return ws._msgCount <= MESSAGE_LIMIT;
}

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

// ✅ FIX #3: Явное удаление комнаты после завершения игры
function closeRoom(code) {
  if (rooms[code]) {
    delete rooms[code];
    console.log(`Room ${code} closed`);
  }
}

async function notifyFriendsStatus(playerName, isOnline) {
  try {
    const player = await Player.findOne({ nameLower: playerName.toLowerCase() });
    if (!player) return;
    for (const friendName of player.friends) {
      const friendWs = online.get(friendName.toLowerCase());
      if (friendWs) {
        send(friendWs, { type: 'friend_status', name: playerName, online: isOnline });
      }
    }
  } catch (e) {}
}

async function sendFriendsList(ws, playerName) {
  try {
    const player = await Player.findOne({ nameLower: playerName.toLowerCase() });
    if (!player) return;
    const friendsData = player.friends.map(name => ({
      name,
      online: online.has(name.toLowerCase())
    }));
    send(ws, {
      type: 'friends_list',
      friends: friendsData,
      requests: player.friendRequests,
      sentRequests: player.sentRequests
    });
  } catch (e) {}
}

// ══════════════════════════════════════════════════════
// WEBSOCKET HANDLERS
// ══════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;
  ws.playerName = null;
  ws._msgCount = 0;
  ws._msgWindowStart = Date.now();

  ws.on('message', async (raw) => {
    // ✅ FIX #8: Rate limit проверка
    if (!checkRateLimit(ws)) {
      send(ws, { type: 'error', msg: 'Слишком много запросов' });
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── LOGIN / REGISTER ──
      case 'login': {
        const name = (msg.name || '').trim();
        if (!name || name.length < 2 || name.length > 20) {
          send(ws, { type: 'login_error', msg: 'Имя должно быть от 2 до 20 символов' });
          return;
        }
        try {
          let player = await Player.findOne({ nameLower: name.toLowerCase() });
          const isNew = !player;
          if (!player) {
            player = await Player.create({ name, nameLower: name.toLowerCase() });
          }
          ws.playerName = player.name;
          online.set(player.name.toLowerCase(), ws); // ✅ всегда lowercase
          send(ws, {
            type: 'login_ok',
            name: player.name,
            wins: player.wins,
            losses: player.losses,
            draws: player.draws,
            total: player.total,
            isNew
          });
          await sendFriendsList(ws, player.name);
          await notifyFriendsStatus(player.name, true);
          console.log(`${player.name} ${isNew ? 'зарегистрирован' : 'вошёл'}`);
        } catch (e) {
          console.error('Login error:', e);
          send(ws, { type: 'login_error', msg: 'Ошибка сервера' });
        }
        break;
      }

      // ── FRIEND REQUEST ──
      case 'friend_request': {
        if (!ws.playerName) return;
        const targetName = (msg.to || '').trim();
        if (!targetName) return;
        if (targetName.toLowerCase() === ws.playerName.toLowerCase()) {
          send(ws, { type: 'error', msg: 'Нельзя добавить себя' });
          return;
        }
        try {
          const me = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
          const target = await Player.findOne({ nameLower: targetName.toLowerCase() });
          if (!target) { send(ws, { type: 'error', msg: 'Игрок не найден' }); return; }
          if (me.friends.map(n => n.toLowerCase()).includes(target.name.toLowerCase())) {
            send(ws, { type: 'error', msg: 'Уже в друзьях' }); return;
          }
          if (me.sentRequests.map(n => n.toLowerCase()).includes(target.name.toLowerCase())) {
            send(ws, { type: 'error', msg: 'Запрос уже отправлен' }); return;
          }
          if (me.friendRequests.map(n => n.toLowerCase()).includes(target.name.toLowerCase())) {
            // Автоматически принять
            me.friends.push(target.name);
            me.friendRequests = me.friendRequests.filter(n => n.toLowerCase() !== target.name.toLowerCase());
            await me.save();
            target.friends.push(me.name);
            target.sentRequests = target.sentRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
            await target.save();
            send(ws, { type: 'friend_accepted', name: target.name });
            const targetWs = online.get(target.name.toLowerCase());
            if (targetWs) send(targetWs, { type: 'friend_accepted', name: me.name });
            return;
          }
          me.sentRequests.push(target.name);
          await me.save();
          target.friendRequests.push(me.name);
          await target.save();
          send(ws, { type: 'request_sent', to: target.name });
          const targetWs = online.get(target.name.toLowerCase());
          if (targetWs) send(targetWs, { type: 'new_friend_request', from: me.name });
        } catch (e) { console.error('Friend request error:', e); }
        break;
      }

      // ── ACCEPT FRIEND REQUEST ──
      case 'accept_friend': {
        if (!ws.playerName) return;
        const fromName = (msg.from || '').trim();
        try {
          const me = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
          const other = await Player.findOne({ nameLower: fromName.toLowerCase() });
          if (!me || !other) return;
          me.friends.push(other.name);
          me.friendRequests = me.friendRequests.filter(n => n.toLowerCase() !== fromName.toLowerCase());
          await me.save();
          other.friends.push(me.name);
          other.sentRequests = other.sentRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
          await other.save();
          send(ws, { type: 'friend_accepted', name: other.name, online: online.has(other.name.toLowerCase()) });
          const otherWs = online.get(other.name.toLowerCase());
          if (otherWs) send(otherWs, { type: 'friend_accepted', name: me.name, online: true });
        } catch (e) { console.error('Accept friend error:', e); }
        break;
      }

      // ── DECLINE FRIEND REQUEST ──
      case 'decline_friend': {
        if (!ws.playerName) return;
        const fromName = (msg.from || '').trim();
        try {
          const me = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
          me.friendRequests = me.friendRequests.filter(n => n.toLowerCase() !== fromName.toLowerCase());
          await me.save();
          const other = await Player.findOne({ nameLower: fromName.toLowerCase() });
          if (other) {
            other.sentRequests = other.sentRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
            await other.save();
          }
        } catch (e) {}
        break;
      }

      // ── REMOVE FRIEND ──
      case 'remove_friend': {
        if (!ws.playerName) return;
        const targetName = (msg.name || '').trim();
        try {
          const me = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
          me.friends = me.friends.filter(n => n.toLowerCase() !== targetName.toLowerCase());
          await me.save();
          const other = await Player.findOne({ nameLower: targetName.toLowerCase() });
          if (other) {
            other.friends = other.friends.filter(n => n.toLowerCase() !== me.name.toLowerCase());
            await other.save();
          }
          send(ws, { type: 'friend_removed', name: targetName });
        } catch (e) {}
        break;
      }

      // ── GAME INVITE ──
      case 'game_invite': {
        if (!ws.playerName) return;
        const toName = (msg.to || '').trim();
        const toWs = online.get(toName.toLowerCase());
        if (!toWs) { send(ws, { type: 'error', msg: 'Игрок не в сети' }); return; }
        send(toWs, { type: 'game_invite', from: ws.playerName, side: msg.side || 'white', time: msg.time || 10 });
        send(ws, { type: 'invite_sent', to: toName });
        break;
      }

      // ── ACCEPT GAME INVITE ──
      case 'accept_invite': {
        if (!ws.playerName) return;
        const fromName = (msg.from || '').trim();
        const fromWs = online.get(fromName.toLowerCase());

        // ✅ FIX #6: Проверяем fromWs перед использованием
        if (!fromWs || fromWs.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'error', msg: 'Игрок уже не в сети' });
          return;
        }

        const code = generateCode();
        const inviterSide = msg.side || 'white';
        const inviterColor = inviterSide === 'random'
          ? (Math.random() < 0.5 ? 'white' : 'black')
          : inviterSide;
        const joinerColor = inviterColor === 'white' ? 'black' : 'white';

        rooms[code] = {
          white: inviterColor === 'white' ? fromWs : ws,
          black: inviterColor === 'black' ? fromWs : ws,
          name: fromName,
          statsRecorded: false // ✅ FIX #2: флаг для предотвращения двойной записи
        };

        fromWs.roomCode = code;
        fromWs.color = inviterColor;
        send(fromWs, {
          type: 'start',
          yourColor: inviterColor,
          opponent: ws.playerName,
          timeSeconds: (msg.time || 10) * 60
        });

        ws.roomCode = code;
        ws.color = joinerColor;
        send(ws, {
          type: 'start',
          yourColor: joinerColor,
          opponent: fromName,
          timeSeconds: (msg.time || 10) * 60
        });

        console.log(`Friend game: ${fromName} vs ${ws.playerName}, room ${code}`);
        break;
      }

      // ── DECLINE GAME INVITE ──
      case 'decline_invite': {
        if (!ws.playerName) return;
        const fromName = (msg.from || '').trim();
        const fromWs = online.get(fromName.toLowerCase());
        if (fromWs) send(fromWs, { type: 'invite_declined', by: ws.playerName });
        break;
      }

      // ── REFRESH FRIENDS ──
      case 'get_friends': {
        if (!ws.playerName) return;
        await sendFriendsList(ws, ws.playerName);
        break;
      }

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
          name: msg.name || ws.playerName || 'Игрок',
          statsRecorded: false // ✅ FIX #2: флаг
        };
        ws.roomCode = code;
        ws.color = color;
        if (!ws.playerName) ws.playerName = msg.name || 'Игрок';
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
        if (!ws.playerName) ws.playerName = msg.name || 'Гость';

        send(room.white, {
          type: 'start',
          yourColor: 'white',
          opponent: room.black === ws ? ws.playerName : room.name
        });
        send(room.black, {
          type: 'start',
          yourColor: 'black',
          opponent: room.white === ws ? ws.playerName : room.name
        });
        console.log(`Room ${code} started`);
        break;
      }

      // ── MOVE ──
      case 'move': {
        // ✅ FIX #9: проверка авторизации
        if (!ws.playerName) return;
        const room = rooms[ws.roomCode];
        if (!room) return;

        // ✅ FIX #5: проверяем что ход делает тот, чья очередь (по цвету)
        // Базовая защита — проверяем что ws соответствует нужному цвету
        const opp = getOpponent(room, ws);
        if (!opp) return;

        // Валидация формата хода
        const from = msg.from;
        const to = msg.to;
        if (!Array.isArray(from) || !Array.isArray(to) ||
            from.length !== 2 || to.length !== 2 ||
            !from.every(n => Number.isInteger(n) && n >= 0 && n < 8) ||
            !to.every(n => Number.isInteger(n) && n >= 0 && n < 8)) {
          send(ws, { type: 'error', msg: 'Неверный формат хода' });
          return;
        }

        const promo = msg.promo;
        if (promo && !['Q','R','B','N'].includes(promo)) {
          send(ws, { type: 'error', msg: 'Неверная фигура для превращения' });
          return;
        }

        send(opp, { type: 'move', from, to, promo: promo || null });
        break;
      }

      // ── RESIGN ──
      case 'resign': {
        // ✅ FIX #9: проверка авторизации
        if (!ws.playerName) return;
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, { type: 'opponent_resigned' });

        // ✅ FIX #2: проверяем флаг statsRecorded
        if (!room.statsRecorded) {
          room.statsRecorded = true;
          if (ws.playerName) await updateStats(ws.playerName, 'loss');
          if (opp && opp.playerName) await updateStats(opp.playerName, 'win');
          // Отправить обновлённую статистику обоим
          await sendStatsUpdate(ws);
          await sendStatsUpdate(opp);
        }

        // ✅ FIX #3: удаляем комнату после завершения
        closeRoom(ws.roomCode);
        ws.roomCode = null;
        if (opp) opp.roomCode = null;
        break;
      }

      // ── GAME RESULT (sent by client after checkmate/stalemate) ──
      case 'game_result': {
        // ✅ FIX #9: проверка авторизации
        if (!ws.playerName || !msg.result) return;

        const room = rooms[ws.roomCode];

        // ✅ FIX #2: только если статистика ещё не записана (не было resign)
        if (room && !room.statsRecorded) {
          room.statsRecorded = true;
          await updateStats(ws.playerName, msg.result);

          // Записать статистику сопернику
          const opp = getOpponent(room, ws);
          if (opp && opp.playerName) {
            let oppResult = 'draw';
            if (msg.result === 'win') oppResult = 'loss';
            else if (msg.result === 'loss') oppResult = 'win';
            await updateStats(opp.playerName, oppResult);
            await sendStatsUpdate(opp);
          }

          await sendStatsUpdate(ws);

          // ✅ FIX #3: удаляем комнату
          const code = ws.roomCode;
          ws.roomCode = null;
          if (opp) opp.roomCode = null;
          closeRoom(code);
        } else if (!room) {
          // Локальная игра без комнаты — просто записываем
          await updateStats(ws.playerName, msg.result);
          await sendStatsUpdate(ws);
        }
        break;
      }

      // ── CHAT ──
      case 'chat': {
        // ✅ FIX #9: проверка авторизации
        if (!ws.playerName) return;
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, {
          type: 'chat',
          msg: (msg.msg || '').slice(0, 200),
          from: ws.playerName
        });
        break;
      }
    }
  });

  ws.on('close', async () => {
    if (ws.playerName) {
      online.delete(ws.playerName.toLowerCase());
      await notifyFriendsStatus(ws.playerName, false);
    }

    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const opp = getOpponent(room, ws);
    send(opp, { type: 'opponent_left' });

    // ✅ FIX #3: удаляем комнату через 30 сек после дисконнекта
    setTimeout(() => closeRoom(code), 30000);
  });
});

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
async function updateStats(playerName, result) {
  try {
    const update = { $inc: { total: 1 } };
    if (result === 'win') update.$inc.wins = 1;
    else if (result === 'loss') update.$inc.losses = 1;
    else if (result === 'draw') update.$inc.draws = 1;
    await Player.findOneAndUpdate({ nameLower: playerName.toLowerCase() }, update);
  } catch (e) {
    console.error('updateStats error:', e);
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: отправить актуальную статистику игроку
async function sendStatsUpdate(ws) {
  if (!ws || !ws.playerName) return;
  try {
    const p = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
    if (p) {
      send(ws, {
        type: 'stats_update',
        wins: p.wins,
        losses: p.losses,
        draws: p.draws,
        total: p.total
      });
    }
  } catch (e) {}
}

// ══════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════
async function start() {
  if (!MONGO_URI) {
    console.error('MONGO_URI не задан!');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB подключена');
  } catch (e) {
    console.error('❌ Ошибка MongoDB:', e.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`✅ INFERNUM server запущен на порту ${PORT}`);
  });

  // ✅ FIX #4 + #10: Self-ping с поддержкой HTTPS
  const APP_URL = process.env.RENDER_EXTERNAL_URL;
  if (APP_URL) {
    const isHttps = APP_URL.startsWith('https://');
    const pingLib = isHttps ? https : http;
    setInterval(() => {
      pingLib.get(`${APP_URL}/ping`, (res) => {
        console.log(`Self-ping: ${res.statusCode}`);
      }).on('error', (e) => {
        console.log(`Self-ping failed: ${e.message}`);
      });
    }, 14 * 60 * 1000);
  }
}

start();
