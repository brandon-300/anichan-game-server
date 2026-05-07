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

    const game = msg.game;
    if (!game || (game !== 'tic-tac-toe' && game !== 'chess')) return;

    switch (msg.type) {
      // ─── Create public ───
      case 'create_public': {
        const hostColor = game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game,
          players: [ws],
          hostWs: ws,
          public: true,
          code: null,
          hostColor,
          board: game === 'tic-tac-toe' ? Array(9).fill('') : null,
          turn: game === 'tic-tac-toe' ? 'X' : 'w',
        });
        ws.roomId = roomId;
        ws.game = game;
        sendTo(ws, { type: 'room_created', roomId, public: true });
        break;
      }

      // ─── Join public ───
      case 'join_public': {
        let foundRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === game && room.public &&
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
        ws.game = game;
        foundRoom.players.forEach((player, idx) => {
          const symbol = idx === 0
            ? (game === 'tic-tac-toe' ? 'X' : (foundRoom.hostColor || 'w'))
            : (game === 'tic-tac-toe' ? 'O' : (foundRoom.hostColor === 'w' ? 'b' : 'w'));
          sendTo(player, { type: 'start', symbol, turn: game === 'tic-tac-toe' ? 'X' : 'w' });
        });
        break;
      }

      // ─── Create private ───
      case 'create_private': {
        const code = msg.code;
        if (!code || !/^[A-Za-z0-9]+$/.test(code)) {
          sendTo(ws, { type: 'error', message: 'Invalid code.' });
          return;
        }
        const roomId = generateId();
        rooms.set(roomId, {
          game,
          players: [ws],
          hostWs: ws,
          public: false,
          code,
          hostColor: null,
          board: game === 'tic-tac-toe' ? Array(9).fill('') : null,
          turn: game === 'tic-tac-toe' ? 'X' : 'w',
        });
        ws.roomId = roomId;
        ws.game = game;
        sendTo(ws, { type: 'room_created', roomId, public: false, code });
        break;
      }

      // ─── Join private ───
      case 'join_private': {
        const code = msg.code;
        if (!code) {
          sendTo(ws, { type: 'error', message: 'Enter a room code.' });
          return;
        }
        let targetRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === game && !room.public && room.code === code &&
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
        ws.game = game;
        targetRoom.players.forEach((player, idx) => {
          const symbol = game === 'tic-tac-toe' ? (idx === 0 ? 'X' : 'O') : (idx === 0 ? 'w' : 'b');
          sendTo(player, { type: 'start', symbol, turn: game === 'tic-tac-toe' ? 'X' : 'w' });
        });
        break;
      }

      // ─── Leave room ───
      case 'leave_room': {
        if (ws.roomId) {
          const room = rooms.get(ws.roomId);
          if (room) {
            rooms.delete(ws.roomId);
            room.players.forEach(p => {
              if (p !== ws && p.readyState === WebSocket.OPEN) {
                sendTo(p, { type: 'opponent_disconnected' });
              }
            });
          }
          ws.roomId = null;
        }
        break;
      }

      // ─── Chat ───
      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const opponent = room.players.find(p => p && p !== ws);
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          sendTo(opponent, { type: 'chat', text: msg.text });
        }
        break;
      }

      // ─── Move ───
      case 'move': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        if (room.game === 'tic-tac-toe' && msg.data.index !== undefined && room.board) {
          room.board[msg.data.index] = ws.symbol;
          room.turn = ws.symbol === 'X' ? 'O' : 'X';
        }
        const opponent = room.players.find(p => p && p !== ws);
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
        rooms.delete(ws.roomId);
        room.players.forEach(p => {
          if (p !== ws && p.readyState === WebSocket.OPEN) {
            sendTo(p, { type: 'opponent_disconnected' });
          }
        });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});