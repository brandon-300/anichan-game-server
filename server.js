const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// HTTP server so Render sees the app as healthy
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

// ------------------ Game rooms ------------------
const rooms = new Map();          // roomId -> { game, players: [ws], public, code, hostWs, ... }
const tttWaiting = [];           // simple queue for tic-tac-toe

function generateId() {
  return Math.random().toString(36).substring(2, 8);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ------------------ WebSocket handling ------------------
wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.game = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendTo(ws, { type: 'error', message: 'Invalid JSON' });
    }

    // ---- Tic-Tac-Toe (unchanged) ----
    if (msg.game === 'tic-tac-toe') {
      handleTTT(ws, msg);
      return;
    }

    // ---- Chess ----
    if (msg.game !== 'chess') return;

    switch (msg.type) {
      case 'create_public': {
        const roomId = generateId();
        rooms.set(roomId, {
          game: 'chess',
          players: [ws],
          hostWs: ws,
          public: true,
          code: null,
        });
        ws.roomId = roomId;
        ws.game = 'chess';
        sendTo(ws, { type: 'room_created', roomId, public: true });
        break;
      }

      case 'join_public': {
        // find a public room with exactly one waiting player
        let foundRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === 'chess' && room.public &&
              room.players.length === 1 &&
              room.players[0].readyState === WebSocket.OPEN) {
            foundRoom = room;
            ws.roomId = id;
            break;
          }
        }
        if (!foundRoom) {
          sendTo(ws, { type: 'error', message: 'No public room available. Create one first.' });
          return;
        }
        foundRoom.players.push(ws);
        ws.game = 'chess';
        // start the game
        foundRoom.players.forEach((player, idx) => {
          const symbol = idx === 0 ? 'w' : 'b';
          sendTo(player, { type: 'start', symbol });
        });
        break;
      }

      case 'create_private': {
        const code = msg.code;
        if (!code || !/^[A-Za-z0-9]+$/.test(code)) {
          sendTo(ws, { type: 'error', message: 'Invalid code. Use only letters and numbers.' });
          return;
        }
        const roomId = generateId();
        rooms.set(roomId, {
          game: 'chess',
          players: [ws],
          hostWs: ws,
          public: false,
          code: code,
        });
        ws.roomId = roomId;
        ws.game = 'chess';
        sendTo(ws, { type: 'room_created', roomId, public: false, code });
        break;
      }

      case 'join_private': {
        const code = msg.code;
        if (!code) {
          sendTo(ws, { type: 'error', message: 'Please provide a room code.' });
          return;
        }
        let targetRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === 'chess' &&
              !room.public &&
              room.code === code &&
              room.players.length === 1 &&
              room.players[0].readyState === WebSocket.OPEN) {
            targetRoom = room;
            ws.roomId = id;
            break;
          }
        }
        if (!targetRoom) {
          sendTo(ws, { type: 'error', message: 'No private room found with that code.' });
          return;
        }
        targetRoom.players.push(ws);
        ws.game = 'chess';
        targetRoom.players.forEach((player, idx) => {
          const symbol = idx === 0 ? 'w' : 'b';
          sendTo(player, { type: 'start', symbol });
        });
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const opponent = room.players.find(p => p !== ws);
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          sendTo(opponent, { type: 'chat', text: msg.text });
        }
        break;
      }

      case 'move': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const opponent = room.players.find(p => p !== ws);
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          sendTo(opponent, { type: 'move', data: msg.data });
        }
        break;
      }

      default:
        // ignore unknown message types
        break;
    }
  });

  ws.on('close', () => {
    // clean up when a player disconnects
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.forEach(p => {
          if (p !== ws && p.readyState === WebSocket.OPEN) {
            sendTo(p, { type: 'opponent_disconnected' });
          }
        });
        rooms.delete(ws.roomId);
      }
    }
    // remove from tic-tac-toe waiting list if present
    const tttIdx = tttWaiting.indexOf(ws);
    if (tttIdx !== -1) tttWaiting.splice(tttIdx, 1);
  });
});

// ---------- Tic-Tac-Toe handling ----------
function handleTTT(ws, msg) {
  if (msg.type === 'join') {
    if (tttWaiting.length > 0) {
      const opp = tttWaiting.shift();
      const roomId = generateId();
      rooms.set(roomId, { game: 'tic-tac-toe', players: [opp, ws] });
      opp.roomId = roomId;
      ws.roomId = roomId;
      opp.game = 'tic-tac-toe';
      ws.game = 'tic-tac-toe';
      sendTo(opp, { type: 'start', symbol: 'X', turn: 'X' });
      sendTo(ws, { type: 'start', symbol: 'O', turn: 'X' });
    } else {
      tttWaiting.push(ws);
      sendTo(ws, { type: 'waiting' });
    }
  } else if (msg.type === 'move') {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const opponent = room.players.find(p => p !== ws);
    if (opponent) sendTo(opponent, { type: 'move', data: msg.data });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});