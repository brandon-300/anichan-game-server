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

      // ─── Join public ───
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

      // ─── Create private ───
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

      // ─── Join private ───
      case 'join_private': {
        const code = msg.code;
        if (!code) {
          sendTo(ws, { type: 'error', message: 'Please enter a room code.' });
          return;
        }
        let targetRoom = null;
        for (const [id, room] of rooms) {
          if (room.game === game && !room.public && room.code === code &&
              room.players[0] && room.players[0].readyState === WebSocket.OPEN &&
              !room.players[1]) {
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

      // ─── Reconnect (opponent only) ───
      case 'reconnect': {
        const { roomId, symbol, code } = msg;
        const room = rooms.get(roomId);
        if (!room) {
          sendTo(ws, { type: 'error', message: 'Room no longer exists.' });
          return;
        }
        if (room.public === false) {
          if (!code || code !== room.code) {
            sendTo(ws, { type: 'error', message: 'Incorrect room code.' });
            return;
          }
        }
        const playerIdx = (symbol === 'X' || symbol === 'w') ? 0 : 1;
        if (playerIdx === 0) {
          sendTo(ws, { type: 'error', message: 'Cannot reconnect as host.' });
          return;
        }
        const existing = room.players[playerIdx];
        if (existing && existing.readyState !== WebSocket.OPEN) {
          // Replace the disconnected opponent
          room.players[playerIdx] = ws;
          ws.roomId = roomId;
          ws.game = game;
          ws.symbol = symbol;
          ws.isHost = false;
          if (room.disconnectTimers[playerIdx]) {
            clearTimeout(room.disconnectTimers[playerIdx]);
            room.disconnectTimers[playerIdx] = null;
          }
          sendTo(ws, { type: 'resume', symbol, turn: room.turn, board: room.board });
          const host = room.players[0];
          if (host && host.readyState === WebSocket.OPEN) {
            sendTo(host, { type: 'opponent_reconnected' });
          }
        } else {
          sendTo(ws, { type: 'error', message: 'Cannot reconnect to this game.' });
        }
        break;
      }

      // ─── Rematch ───
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

      // ─── Leave room ───
      case 'leave_room': {
        if (ws.roomId) {
          const room = rooms.get(ws.roomId);
          if (room) {
            if (ws.isHost) {
              // Destroy instantly
              const other = room.players[1];
              if (other && other.readyState === WebSocket.OPEN) {
                sendTo(other, { type: 'room_destroyed', message: 'Host left the game.' });
                other.close();
              }
              rooms.delete(ws.roomId);
            } else {
              // Opponent left – start timer but also notify host
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
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        if (ws.isHost) {
          // Host left -> destroy room immediately
          const other = room.players[1];
          if (other && other.readyState === WebSocket.OPEN) {
            sendTo(other, { type: 'room_destroyed', message: 'Host left the game.' });
            other.close();
          }
          // clear timers
          room.disconnectTimers.forEach(t => clearTimeout(t));
          rooms.delete(ws.roomId);
        } else {
          // Opponent disconnected -> start 5‑minute timer
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
          // Notify host
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