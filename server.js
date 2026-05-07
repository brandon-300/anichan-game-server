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
  ws.symbol = null;

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
      // ---------- Create public ----------
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
        ws.symbol = game === 'tic-tac-toe' ? 'X' : (hostColor || 'w');
        sendTo(ws, { type: 'room_created', roomId, public: true });
        break;
      }

      // ---------- Join public ----------
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
        if (game === 'tic-tac-toe') {
          ws.symbol = 'O';
          foundRoom.players.forEach((player, idx) => {
            const sym = idx === 0 ? 'X' : 'O';
            player.symbol = sym;
            sendTo(player, { type: 'start', symbol: sym, turn: 'X' });
          });
        } else { // chess
          const hostColor = foundRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          foundRoom.players.forEach((player, idx) => {
            const sym = idx === 0 ? hostColor : opponentColor;
            player.symbol = sym;
            sendTo(player, { type: 'start', symbol: sym });
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
        const hostColor = game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game,
          players: [ws],
          hostWs: ws,
          public: false,
          code,
          hostColor,
          board: game === 'tic-tac-toe' ? Array(9).fill('') : null,
          turn: game === 'tic-tac-toe' ? 'X' : 'w',
        });
        ws.roomId = roomId;
        ws.game = game;
        ws.symbol = game === 'tic-tac-toe' ? 'X' : (hostColor || 'w');
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
          if (room.game === game &&
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
        ws.game = game;
        if (game === 'tic-tac-toe') {
          ws.symbol = 'O';
          targetRoom.players.forEach((player, idx) => {
            const sym = idx === 0 ? 'X' : 'O';
            player.symbol = sym;
            sendTo(player, { type: 'start', symbol: sym, turn: 'X' });
          });
        } else { // chess
          const hostColor = targetRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          targetRoom.players.forEach((player, idx) => {
            const sym = idx === 0 ? hostColor : opponentColor;
            player.symbol = sym;
            sendTo(player, { type: 'start', symbol: sym });
          });
        }
        break;
      }

      // ---------- Reconnect ----------
      case 'reconnect': {
        const { roomId, symbol } = msg;
        const room = rooms.get(roomId);
        if (!room) {
          sendTo(ws, { type: 'error', message: 'Room no longer exists.' });
          return;
        }
        // Find the player slot that matches the symbol
        const playerIdx = (symbol === 'X' || symbol === 'w') ? 0 : 1;
        const existingPlayer = room.players[playerIdx];
        if (existingPlayer && existingPlayer.readyState !== WebSocket.OPEN) {
          // Replace the disconnected player
          room.players[playerIdx] = ws;
          ws.roomId = roomId;
          ws.game = game;
          ws.symbol = symbol;
          // Send current game state to the reconnected player
          sendTo(ws, {
            type: 'resume',
            symbol,
            turn: room.turn,
            board: room.board,    // for Tic-Tac-Toe
          });
          // Notify the other player that opponent is back
          const other = room.players[1 - playerIdx];
          if (other && other.readyState === WebSocket.OPEN) {
            sendTo(other, { type: 'opponent_reconnected' });
          }
        } else {
          sendTo(ws, { type: 'error', message: 'Cannot reconnect at this time.' });
        }
        break;
      }

      // ---------- Rematch (Tic-Tac-Toe) ----------
      case 'rematch': {
        const room = rooms.get(ws.roomId);
        if (!room || room.game !== 'tic-tac-toe') return;
        // Reset board and switch starting player
        room.board = Array(9).fill('');
        room.turn = room.turn === 'X' ? 'O' : 'X';
        // Inform both players of new game
        room.players.forEach((player) => {
          if (player && player.readyState === WebSocket.OPEN) {
            sendTo(player, {
              type: 'start',
              symbol: player.symbol,
              turn: room.turn,
            });
          }
        });
        break;
      }

      // ---------- Leave room ----------
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
        // Update board for Tic-Tac-Toe
        if (room.game === 'tic-tac-toe' && msg.data.index !== undefined && room.board) {
          room.board[msg.data.index] = ws.symbol;
          room.turn = ws.symbol === 'X' ? 'O' : 'X';
        }
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
        // Keep the room alive for 30 seconds to allow reconnection
        // If already waiting, don't overwrite
        if (!room._disconnectTimer) {
          room._disconnectTimer = setTimeout(() => {
            // Remove the room if still not fully connected
            const active = room.players.some(p => p && p.readyState === WebSocket.OPEN);
            if (!active) {
              rooms.delete(ws.roomId);
            } else {
              // If one player is still connected, notify them of disconnect
              room.players.forEach(p => {
                if (p && p.readyState === WebSocket.OPEN) {
                  sendTo(p, { type: 'opponent_disconnected' });
                }
              });
            }
            delete room._disconnectTimer;
          }, 30000);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});