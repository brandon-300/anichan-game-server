const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Create an HTTP server that responds to health checks
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

// room handling (unchanged)
const rooms = new Map();

function generateId() {
  return Math.random().toString(36).substring(2, 8);
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'join') {
      const game = msg.game;
      let roomId = null;

      for (const [id, room] of rooms) {
        if (room.game === game && room.players.length === 1 && room.players[0].readyState === WebSocket.OPEN) {
          roomId = id;
          break;
        }
      }

      if (roomId) {
        const room = rooms.get(roomId);
        room.players.push(ws);
        ws.roomId = roomId;
        const symbol = room.players.indexOf(ws) === 0
          ? (game === 'tic-tac-toe' ? 'X' : 'w')
          : (game === 'tic-tac-toe' ? 'O' : 'b');

        room.players.forEach((player, idx) => {
          const playerSymbol = idx === 0
            ? (game === 'tic-tac-toe' ? 'X' : 'w')
            : (game === 'tic-tac-toe' ? 'O' : 'b');
          player.send(JSON.stringify({
            type: 'start',
            symbol: playerSymbol,
            turn: game === 'tic-tac-toe' ? 'X' : 'w'
          }));
        });
      } else {
        roomId = generateId();
        rooms.set(roomId, { game, players: [ws], createdAt: Date.now() });
        ws.roomId = roomId;
        ws.send(JSON.stringify({ type: 'waiting', roomId }));
      }
    } else if (msg.type === 'move') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const opponent = room.players.find(p => p !== ws);
      if (opponent && opponent.readyState === WebSocket.OPEN) {
        opponent.send(JSON.stringify({ type: 'move', data: msg.data }));
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.forEach(p => {
          if (p !== ws && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'opponent_disconnected' }));
          }
        });
        rooms.delete(ws.roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});