const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

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

const rooms = new Map();
const tttWaiting = []; // fallback public queue (not used once we have rooms)

function generateId() {
  return Math.random().toString(36).substring(2, 8);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

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

    // Allow both 'tic-tac-toe' and 'chess'
    if (!msg.game || (msg.game !== 'tic-tac-toe' && msg.game !== 'chess')) return;

    switch (msg.type) {
      // ---------- Create public ----------
      case 'create_public': {
        const hostColor = msg.game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game: msg.game,
          players: [ws],
          hostWs: ws,
          public: true,
          code: null,
          hostColor,
        });
        ws.roomId = roomId;
        ws.game = msg.game;
        sendTo(ws, { type: 'room_created', roomId, public: true });
        break;
      }

      // ---------- Join public ----------
      case 'join_public': {
        let foundRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === msg.game && room.public &&
              room.players.length === 1 &&
              room.players[0].readyState === WebSocket.OPEN) {
            foundRoom = room;
            ws.roomId = id;
            break;
          }
        }
        if (!foundRoom) {
          sendTo(ws, { type: 'error', message: 'No public room available.' });
          return;
        }
        foundRoom.players.push(ws);
        ws.game = msg.game;
        if (msg.game === 'tic-tac-toe') {
          foundRoom.players.forEach((player, idx) => {
            sendTo(player, { type: 'start', symbol: idx === 0 ? 'X' : 'O' });
          });
        } else { // chess
          const hostColor = foundRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          foundRoom.players.forEach((player, idx) => {
            sendTo(player, { type: 'start', symbol: idx === 0 ? hostColor : opponentColor });
          });
        }
        break;
      }

      // ---------- Create private ----------
      case 'create_private': {
        const code = msg.code;
        if (!code || !/^[A-Za-z0-9]+$/.test(code)) {
          sendTo(ws, { type: 'error', message: 'Invalid code. Use letters and numbers only.' });
          return;
        }
        const hostColor = msg.game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game: msg.game,
          players: [ws],
          hostWs: ws,
          public: false,
          code,
          hostColor,
        });
        ws.roomId = roomId;
        ws.game = msg.game;
        sendTo(ws, { type: 'room_created', roomId, public: false, code });
        break;
      }

      // ---------- Join private ----------
      case 'join_private': {
        const code = msg.code;
        if (!code) {
          sendTo(ws, { type: 'error', message: 'Please enter a room code.' });
          return;
        }
        let targetRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === msg.game &&
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
          sendTo(ws, { type: 'error', message: 'No such room found for that pairing code.' });
          return;
        }
        targetRoom.players.push(ws);
        ws.game = msg.game;
        if (msg.game === 'tic-tac-toe') {
          targetRoom.players.forEach((player, idx) => {
            sendTo(player, { type: 'start', symbol: idx === 0 ? 'X' : 'O' });
          });
        } else { // chess
          const hostColor = targetRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          targetRoom.players.forEach((player, idx) => {
            sendTo(player, { type: 'start', symbol: idx === 0 ? hostColor : opponentColor });
          });
        }
        break;
      }

      case 'leave_room': {
        if (ws.roomId) {
          const room = rooms.get(ws.roomId);
          if (room && room.players.length === 1) {
            rooms.delete(ws.roomId);
            sendTo(ws, { type: 'room_cancelled' });
          }
          ws.roomId = null;
        }
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
    }
  });

  ws.on('close', () => {
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
    const tttIdx = tttWaiting.indexOf(ws);
    if (tttIdx !== -1) tttWaiting.splice(tttIdx, 1);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});