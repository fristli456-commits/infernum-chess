const http = require('http');
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
  friends: [String],           // массив имён друзей
  friendRequests: [String],    // входящие запросы
  sentRequests: [String],      // исходящие запросы
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

// online players: name -> ws
const online = new Map();

// game rooms: code -> { white: ws, black: ws, name: str }
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

// Уведомить друзей об изменении онлайн-статуса
async function notifyFriendsStatus(playerName, isOnline) {
  try {
    const player = await Player.findOne({ nameLower: playerName.toLowerCase() });
    if (!player) return;
    for (const friendName of player.friends) {
      const friendWs = online.get(friendName.toLowerCase());
      if (friendWs) {
        send(friendWs, {
          type: 'friend_status',
          name: playerName,
          online: isOnline
        });
      }
    }
  } catch (e) {}
}

// Отправить список друзей с онлайн-статусом
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

  ws.on('message', async (raw) => {
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
            player = await Player.create({
              name,
              nameLower: name.toLowerCase(),
            });
          }

          ws.playerName = player.name;
          online.set(player.name.toLowerCase(), ws);

          send(ws, {
            type: 'login_ok',
            name: player.name,
            wins: player.wins,
            losses: player.losses,
            draws: player.draws,
            total: player.total,
            isNew
          });

          // Отправить список друзей
          await sendFriendsList(ws, player.name);

          // Уведомить друзей что игрок онлайн
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

          if (!target) {
            send(ws, { type: 'error', msg: 'Игрок не найден' });
            return;
          }
          if (me.friends.includes(target.name)) {
            send(ws, { type: 'error', msg: 'Уже в друзьях' });
            return;
          }
          if (me.sentRequests.includes(target.name)) {
            send(ws, { type: 'error', msg: 'Запрос уже отправлен' });
            return;
          }

          // Проверить — вдруг target уже отправил запрос нам
          if (me.friendRequests.includes(target.name)) {
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

          // Уведомить target если онлайн
          const targetWs = online.get(target.name.toLowerCase());
          if (targetWs) {
            send(targetWs, { type: 'new_friend_request', from: me.name });
          }
        } catch (e) {
          console.error('Friend request error:', e);
        }
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

          send(ws, {
            type: 'friend_accepted',
            name: other.name,
            online: online.has(other.name.toLowerCase())
          });

          const otherWs = online.get(other.name.toLowerCase());
          if (otherWs) {
            send(otherWs, {
              type: 'friend_accepted',
              name: me.name,
              online: true
            });
          }
        } catch (e) {
          console.error('Accept friend error:', e);
        }
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
        if (!toWs) {
          send(ws, { type: 'error', msg: 'Игрок не в сети' });
          return;
        }
        send(toWs, {
          type: 'game_invite',
          from: ws.playerName,
          side: msg.side || 'white',
          time: msg.time || 10
        });
        send(ws, { type: 'invite_sent', to: toName });
        break;
      }

      // ── ACCEPT GAME INVITE ──
      case 'accept_invite': {
        if (!ws.playerName) return;
        const fromName = (msg.from || '').trim();
        const fromWs = online.get(fromName.toLowerCase());

        const code = generateCode();
        const inviterSide = msg.side || 'white';
        const inviterColor = inviterSide === 'random'
          ? (Math.random() < 0.5 ? 'white' : 'black')
          : inviterSide;
        const joinerColor = inviterColor === 'white' ? 'black' : 'white';

        rooms[code] = {
          white: inviterColor === 'white' ? fromWs : ws,
          black: inviterColor === 'black' ? fromWs : ws,
          name: fromName
        };

        if (fromWs) {
          fromWs.roomCode = code;
          fromWs.color = inviterColor;
          send(fromWs, {
            type: 'start',
            yourColor: inviterColor,
            opponent: ws.playerName,
            timeSeconds: (msg.time || 10) * 60
          });
        }

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
          name: msg.name || ws.playerName || 'Игрок'
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
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, { type: 'move', from: msg.from, to: msg.to, promo: msg.promo });
        break;
      }

      // ── RESIGN ──
      case 'resign': {
        const room = rooms[ws.roomCode];
        if (!room) return;
        const opp = getOpponent(room, ws);
        send(opp, { type: 'opponent_resigned' });
        // Save stats
        if (ws.playerName) await updateStats(ws.playerName, 'loss');
        if (opp && opp.playerName) await updateStats(opp.playerName, 'win');
        break;
      }

      // ── GAME RESULT (sent by client after checkmate/stalemate) ──
      case 'game_result': {
        if (!ws.playerName || !msg.result) return;
        await updateStats(ws.playerName, msg.result);
        // Send updated stats back
        try {
          const p = await Player.findOne({ nameLower: ws.playerName.toLowerCase() });
          if (p) send(ws, {
            type: 'stats_update',
            wins: p.wins, losses: p.losses, draws: p.draws, total: p.total
          });
        } catch (e) {}
        break;
      }

      // ── CHAT ──
      case 'chat': {
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
    // Remove from online
    if (ws.playerName) {
      online.delete(ws.playerName.toLowerCase());
      await notifyFriendsStatus(ws.playerName, false);
    }

    // Handle room disconnect
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const opp = getOpponent(room, ws);
    send(opp, { type: 'opponent_left' });

    setTimeout(() => {
      if (rooms[code]) delete rooms[code];
    }, 30000);
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

  // Keep-alive self-ping
  const APP_URL = process.env.RENDER_EXTERNAL_URL;
  if (APP_URL) {
    setInterval(() => {
      http.get(`${APP_URL}/ping`, (res) => {
        console.log(`Self-ping: ${res.statusCode}`);
      }).on('error', (e) => {
        console.log(`Self-ping failed: ${e.message}`);
      });
    }, 14 * 60 * 1000);
  }
}

start();
