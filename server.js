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
  ws.isHost = false;

  // Ping every 30s to keep connection alive
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

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
      case 'create_public': {
        const hostColor = game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game,
          players: [ws, null],
          hostWs: ws,
          public: true,
          code: null,
          hostColor,
          board: game === 'tic-tac-toe' ? Array(9).fill('') : null,
          turn: game === 'tic-tac-toe' ? 'X' : 'w',
          disconnectTimers: [null, null],
        });
        ws.roomId = roomId;
        ws.game = game;
        ws.symbol = game === 'tic-tac-toe' ? 'X' : (hostColor || 'w');
        ws.isHost = true;
        sendTo(ws, { type: 'room_created', roomId, public: true });
        break;
      }

      case 'join_public': {
        let foundRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === game && room.public &&
              room.players[0] && room.players[0].readyState === WebSocket.OPEN &&
              !room.players[1]) {
            foundRoom = room;
            ws.roomId = id;
            break;
          }
        }
        if (!foundRoom) {
          sendTo(ws, { type: 'error', message: 'No public room available.' });
          return;
        }
        foundRoom.players[1] = ws;
        ws.game = game;
        if (game === 'tic-tac-toe') {
          ws.symbol = 'O';
          ws.isHost = false;
          foundRoom.players.forEach((player, idx) => {
            if (player && player.readyState === WebSocket.OPEN) {
              const sym = idx === 0 ? 'X' : 'O';
              player.symbol = sym;
              player.isHost = idx === 0;
              sendTo(player, { type: 'start', symbol: sym, turn: 'X', roomId: id });
            }
          });
        } else { // chess
          const hostColor = foundRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          foundRoom.players.forEach((player, idx) => {
            if (player && player.readyState === WebSocket.OPEN) {
              const sym = idx === 0 ? hostColor : opponentColor;
              player.symbol = sym;
              player.isHost = idx === 0;
              sendTo(player, { type: 'start', symbol: sym, roomId: id });
            }
          });
        }
        break;
      }

      case 'create_private': {
        const code = msg.code;
        if (!code || !/^[A-Za-z0-9]+$/.test(code)) {
          sendTo(ws, { type: 'error', message: 'Invalid code. Use letters and numbers only.' });
          return;
        }
        // Check if code already in use
        for (const room of rooms.values()) {
          if (room.game === game && !room.public && room.code === code &&
              room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
            sendTo(ws, { type: 'error', message: 'Code already in use.' });
            return;
          }
        }
        const hostColor = game === 'chess' ? (msg.color || 'w') : null;
        const roomId = generateId();
        rooms.set(roomId, {
          game,
          players: [ws, null],
          hostWs: ws,
          public: false,
          code,
          hostColor,
          board: game === 'tic-tac-toe' ? Array(9).fill('') : null,
          turn: game === 'tic-tac-toe' ? 'X' : 'w',
          disconnectTimers: [null, null],
        });
        ws.roomId = roomId;
        ws.game = game;
        ws.symbol = game === 'tic-tac-toe' ? 'X' : (hostColor || 'w');
        ws.isHost = true;
        sendTo(ws, { type: 'room_created', roomId, public: false, code });
        break;
      }

      case 'join_private': {
        const code = msg.code;
        if (!code) {
          sendTo(ws, { type: 'error', message: 'Please enter a room code.' });
          return;
        }
        let targetRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === game && !room.public && room.code === code &&
              room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
            if (room.players[1] && room.players[1].readyState === WebSocket.OPEN) {
              sendTo(ws, { type: 'error', message: 'Cannot join this game.' });
              return;
            }
            targetRoom = room;
            ws.roomId = id;
            break;
          }
        }
        if (!targetRoom) {
          sendTo(ws, { type: 'error', message: 'No such room found for that pairing code.' });
          return;
        }
        targetRoom.players[1] = ws;
        ws.game = game;
        if (game === 'tic-tac-toe') {
          ws.symbol = 'O';
          ws.isHost = false;
          targetRoom.players.forEach((player, idx) => {
            if (player && player.readyState === WebSocket.OPEN) {
              const sym = idx === 0 ? 'X' : 'O';
              player.symbol = sym;
              player.isHost = idx === 0;
              sendTo(player, { type: 'start', symbol: sym, turn: 'X', roomId: id });
            }
          });
        } else { // chess
          const hostColor = targetRoom.hostColor || 'w';
          const opponentColor = hostColor === 'w' ? 'b' : 'w';
          targetRoom.players.forEach((player, idx) => {
            if (player && player.readyState === WebSocket.OPEN) {
              const sym = idx === 0 ? hostColor : opponentColor;
              player.symbol = sym;
              player.isHost = idx === 0;
              sendTo(player, { type: 'start', symbol: sym, roomId: id });
            }
          });
        }
        break;
      }

      case 'rejoin': {
        const { roomId, symbol, code } = msg;
        if (!roomId || !symbol) {
          sendTo(ws, { type: 'error', message: 'No previous session found.' });
          return;
        }
        const room = rooms.get(roomId);
        if (!room || room.game !== game) {
          sendTo(ws, { type: 'error', message: 'Session expired or no longer exists.' });
          return;
        }
        if (room.public === false) {
          if (!code || code !== room.code) {
            sendTo(ws, { type: 'error', message: 'Incorrect room code.' });
            return;
          }
        }
        const playerIdx = (symbol === 'X' || symbol === 'w') ? 0 : 1;
        const existing = room.players[playerIdx];
        if (existing && existing.readyState !== WebSocket.OPEN) {
          room.players[playerIdx] = ws;
          ws.roomId = roomId;
          ws.game = game;
          ws.symbol = symbol;
          ws.isHost = playerIdx === 0;
          if (room.disconnectTimers[playerIdx]) {
            clearTimeout(room.disconnectTimers[playerIdx]);
            room.disconnectTimers[playerIdx] = null;
          }
          sendTo(ws, { type: 'resume', symbol, turn: room.turn, board: room.board });
          const other = room.players[1 - playerIdx];
          if (other && other.readyState === WebSocket.OPEN) {
            sendTo(other, { type: 'opponent_reconnected' });
          }
        } else {
          sendTo(ws, { type: 'error', message: 'Cannot rejoin this session.' });
        }
        break;
      }

      case 'rematch': {
        const room = rooms.get(ws.roomId);
        if (!room || room.game !== 'tic-tac-toe') return;
        room.board = Array(9).fill('');
        room.turn = room.turn === 'X' ? 'O' : 'X';
        room.players.forEach((player) => {
          if (player && player.readyState === WebSocket.OPEN) {
            sendTo(player, { type: 'start', symbol: player.symbol, turn: room.turn, roomId: ws.roomId });
          }
        });
        break;
      }

      case 'leave_room': {
        if (ws.roomId) {
          const room = rooms.get(ws.roomId);
          if (room) {
            if (ws.isHost) {
              const other = room.players[1];
              if (other && other.readyState === WebSocket.OPEN) {
                sendTo(other, { type: 'room_destroyed', message: 'Host left the game.' });
                other.close();
              }
              rooms.delete(ws.roomId);
            } else {
              const playerIdx = 1;
              if (room.disconnectTimers[playerIdx]) clearTimeout(room.disconnectTimers[playerIdx]);
              room.disconnectTimers[playerIdx] = setTimeout(() => {
                if (room.players[playerIdx] && room.players[playerIdx].readyState !== WebSocket.OPEN) {
                  const host = room.players[0];
                  if (host && host.readyState === WebSocket.OPEN) {
                    sendTo(host, { type: 'room_destroyed', message: 'Opponent failed to return, this room is now destroyed.' });
                    host.close();
                  }
                  rooms.delete(ws.roomId);
                }
              }, 300000);
              const host = room.players[0];
              if (host && host.readyState === WebSocket.OPEN) {
                sendTo(host, { type: 'opponent_disconnected' });
              }
            }
          }
          ws.roomId = null;
        }
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const opponent = room.players.find(p => p && p !== ws);
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          sendTo(opponent, { type: 'chat', text: msg.text });
        }
        break;
      }

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
    clearInterval(ws._pingInterval);
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        if (ws.isHost) {
          const other = room.players[1];
          if (other && other.readyState === WebSocket.OPEN) {
            sendTo(other, { type: 'room_destroyed', message: 'Host left the game.' });
            other.close();
          }
          room.disconnectTimers.forEach(t => clearTimeout(t));
          rooms.delete(ws.roomId);
        } else {
          const playerIdx = 1;
          if (room.disconnectTimers[playerIdx]) clearTimeout(room.disconnectTimers[playerIdx]);
          room.disconnectTimers[playerIdx] = setTimeout(() => {
            if (room.players[playerIdx] && room.players[playerIdx].readyState !== WebSocket.OPEN) {
              const host = room.players[0];
              if (host && host.readyState === WebSocket.OPEN) {
                sendTo(host, { type: 'room_destroyed', message: 'Opponent failed to return, this room is now destroyed.' });
                host.close();
              }
              rooms.delete(ws.roomId);
            }
          }, 300000);
          const host = room.players[0];
          if (host && host.readyState === WebSocket.OPEN) {
            sendTo(host, { type: 'opponent_disconnected' });
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});