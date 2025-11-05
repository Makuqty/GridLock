const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tictactoe');

// User schema
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  avatar: String
});

const User = mongoose.model('User', userSchema);

const onlineUsers = new Map();
const gameRooms = new Map();
const challenges = new Map();
const matchmakingQueue = new Set();
const pendingMatches = new Map();

const JWT_SECRET = 'your-secret-key';

// Auth routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });
    res.json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ username }, JWT_SECRET);
    res.json({ token, user: { username, wins: user.wins, losses: user.losses, draws: user.draws, avatar: user.avatar } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await User.find({}, 'username wins losses draws')
      .sort({ wins: -1 })
      .limit(10);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Socket handling
io.on('connection', (socket) => {
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findOne({ username: decoded.username });
      if (user) {
        socket.username = decoded.username;
        onlineUsers.set(socket.id, { username: decoded.username, socketId: socket.id });
        socket.emit('authenticated', user);
        io.emit('onlineUsers', Array.from(onlineUsers.values()));
      }
    } catch (error) {
      socket.emit('authError', 'Invalid token');
    }
  });

  socket.on('sendChallenge', ({ targetUsername, symbol }) => {
    const targetUser = Array.from(onlineUsers.values()).find(u => u.username === targetUsername);
    if (targetUser) {
      const challengeId = Date.now().toString();
      challenges.set(challengeId, {
        challenger: socket.username,
        challenged: targetUsername,
        challengerSymbol: symbol
      });
      io.to(targetUser.socketId).emit('challengeReceived', {
        challengeId,
        challenger: socket.username
      });
    }
  });

  socket.on('respondToChallenge', ({ challengeId, accepted, symbol }) => {
    const challenge = challenges.get(challengeId);
    if (challenge) {
      const challengerUser = Array.from(onlineUsers.values()).find(u => u.username === challenge.challenger);
      if (accepted && challengerUser) {
        const roomId = `game_${Date.now()}`;
        const firstPlayer = Math.random() < 0.5 ? challenge.challenger : challenge.challenged;
        
        gameRooms.set(roomId, {
          players: {
            [challenge.challenger]: { symbol: challenge.challengerSymbol, socketId: challengerUser.socketId },
            [challenge.challenged]: { symbol: symbol, socketId: socket.id }
          },
          board: Array(9).fill(null),
          currentPlayer: firstPlayer,
          gameState: 'playing',
          lastWinner: null
        });

        [challengerUser.socketId, socket.id].forEach(socketId => {
          io.to(socketId).emit('gameStart', {
            roomId,
            players: gameRooms.get(roomId).players,
            currentPlayer: firstPlayer,
            board: gameRooms.get(roomId).board
          });
        });
      } else {
        io.to(challengerUser?.socketId).emit('challengeDeclined', challenge.challenged);
      }
      challenges.delete(challengeId);
    }
  });

  socket.on('makeMove', ({ roomId, position }) => {
    const room = gameRooms.get(roomId);
    if (room && room.currentPlayer === socket.username && room.board[position] === null) {
      room.board[position] = room.players[socket.username].symbol;
      
      const winner = checkWinner(room.board, room);
      const isDraw = !winner && room.board.every(cell => cell !== null);
      
      if (winner || isDraw) {
        room.gameState = winner ? 'finished' : 'draw';
        if (winner) {
          await User.updateOne({ username: winner }, { $inc: { wins: 1 } });
          const loser = Object.keys(room.players).find(p => p !== winner);
          await User.updateOne({ username: loser }, { $inc: { losses: 1 } });
          room.lastWinner = winner;
        } else {
          await Promise.all(Object.keys(room.players).map(player => 
            User.updateOne({ username: player }, { $inc: { draws: 1 } })
          ));
        }
      } else {
        room.currentPlayer = Object.keys(room.players).find(p => p !== socket.username);
      }

      Object.values(room.players).forEach(player => {
        io.to(player.socketId).emit('gameUpdate', {
          board: room.board,
          currentPlayer: room.currentPlayer,
          gameState: room.gameState,
          winner: winner,
          isDraw: isDraw
        });
      });
    }
  });

  socket.on('sendMessage', ({ roomId, message }) => {
    const room = gameRooms.get(roomId);
    if (room && room.players[socket.username]) {
      Object.values(room.players).forEach(player => {
        io.to(player.socketId).emit('messageReceived', {
          username: socket.username,
          message,
          timestamp: Date.now()
        });
      });
    }
  });

  socket.on('requestRematch', ({ roomId }) => {
    const room = gameRooms.get(roomId);
    if (room && room.players[socket.username]) {
      if (!room.rematchRequests) {
        room.rematchRequests = new Set();
      }
      
      room.rematchRequests.add(socket.username);
      
      // Notify other player
      const otherPlayer = Object.keys(room.players).find(p => p !== socket.username);
      if (otherPlayer) {
        const otherSocketId = room.players[otherPlayer].socketId;
        io.to(otherSocketId).emit('rematchRequested', socket.username);
      }
    }
  });

  socket.on('respondToRematch', ({ roomId, accepted }) => {
    const room = gameRooms.get(roomId);
    if (room && room.players[socket.username]) {
      if (accepted) {
        if (!room.rematchRequests) {
          room.rematchRequests = new Set();
        }
        room.rematchRequests.add(socket.username);
        
        // Check if both players agreed
        if (room.rematchRequests.size === 2) {
          // Start new game
          room.board = Array(9).fill(null);
          room.gameState = 'playing';
          room.currentPlayer = room.lastWinner ? Object.keys(room.players).find(p => p !== room.lastWinner) : Object.keys(room.players)[0];
          room.rematchRequests.clear();
          
          Object.values(room.players).forEach(player => {
            io.to(player.socketId).emit('gameStart', {
              roomId,
              players: room.players,
              currentPlayer: room.currentPlayer,
              board: room.board
            });
          });
        }
      } else {
        // Notify requester that rematch was declined
        Object.values(room.players).forEach(player => {
          if (player.socketId !== socket.id) {
            io.to(player.socketId).emit('rematchDeclined', socket.username);
          }
        });
        room.rematchRequests?.clear();
      }
    }
  });

  socket.on('leaveGame', ({ roomId }) => {
    gameRooms.delete(roomId);
  });

  socket.on('updateAvatar', async (avatar) => {
    if (socket.username) {
      try {
        await User.updateOne({ username: socket.username }, { avatar });
        socket.emit('avatarUpdated', avatar);
      } catch (error) {
        socket.emit('error', 'Failed to update avatar');
      }
    }
  });

  socket.on('findMatch', () => {
    if (socket.username && !matchmakingQueue.has(socket.username)) {
      matchmakingQueue.add(socket.username);
      
      // Try to find a match immediately
      const availablePlayers = Array.from(matchmakingQueue).filter(p => p !== socket.username);
      if (availablePlayers.length > 0) {
        const opponent = availablePlayers[0];
        const opponentUser = Array.from(onlineUsers.values()).find(u => u.username === opponent);
        
        if (opponentUser) {
          // Remove both players from queue
          matchmakingQueue.delete(socket.username);
          matchmakingQueue.delete(opponent);
          
          // Create pending match
          const matchId = `match_${Date.now()}`;
          pendingMatches.set(matchId, {
            players: {
              [socket.username]: { socketId: socket.id, symbol: null },
              [opponent]: { socketId: opponentUser.socketId, symbol: null }
            },
            symbolsChosen: 0,
            chosenSymbols: new Set()
          });
          
          // Notify both players to choose symbols
          io.to(socket.id).emit('matchFound', {
            matchId,
            opponent
          });
          io.to(opponentUser.socketId).emit('matchFound', {
            matchId,
            opponent: socket.username
          });
        }
      }
    }
  });

  socket.on('cancelMatchmaking', () => {
    if (socket.username) {
      matchmakingQueue.delete(socket.username);
    }
  });

  socket.on('matchSymbolChosen', ({ matchId, symbol }) => {
    const match = pendingMatches.get(matchId);
    if (match && match.players[socket.username]) {
      // Check if symbol is already chosen
      if (match.chosenSymbols.has(symbol)) {
        socket.emit('symbolTaken', symbol);
        return;
      }
      
      match.players[socket.username].symbol = symbol;
      match.chosenSymbols.add(symbol);
      match.symbolsChosen++;
      
      socket.emit('symbolAccepted');
      
      // Check if both players have chosen symbols
      if (match.symbolsChosen === 2) {
        const playerNames = Object.keys(match.players);
        const firstPlayer = playerNames[Math.floor(Math.random() * 2)];
        
        // Create game room
        gameRooms.set(matchId, {
          players: match.players,
          board: Array(9).fill(null),
          currentPlayer: firstPlayer,
          gameState: 'playing',
          lastWinner: null
        });
        
        // Start game for both players
        const gameData = {
          roomId: matchId,
          players: match.players,
          currentPlayer: firstPlayer,
          board: Array(9).fill(null)
        };
        
        Object.values(match.players).forEach(player => {
          io.to(player.socketId).emit('gameStart', gameData);
        });
        
        pendingMatches.delete(matchId);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      matchmakingQueue.delete(socket.username);
    }
    onlineUsers.delete(socket.id);
    io.emit('onlineUsers', Array.from(onlineUsers.values()));
  });
});

function checkWinner(board, room) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  
  for (let line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return Object.keys(room.players).find(
        player => room.players[player].symbol === board[a]
      );
    }
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});