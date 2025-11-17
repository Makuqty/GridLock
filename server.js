require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: "googleapis.com"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com/`
});

const db = admin.firestore();
const rtdb = admin.database();

// Use Firebase for data storage
const useFirebase = true;
const users = new Map();
const USERS_FILE = 'users.json';

// Load users for fallback if needed
loadUsers();

function loadUsers() {
  try {
    if (require('fs').existsSync(USERS_FILE)) {
      const data = require('fs').readFileSync(USERS_FILE, 'utf8');
      const usersArray = JSON.parse(data);
      usersArray.forEach(user => users.set(user.username, user));
    }
  } catch (error) {
    console.log('Starting with empty users');
  }
}

function saveUsers() {
  const usersArray = Array.from(users.values());
  require('fs').writeFileSync(USERS_FILE, JSON.stringify(usersArray, null, 2));
}

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

    if (useFirebase) {
      const userRef = db.collection('users').doc(username);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      await userRef.set({
        username,
        password: hashedPassword,
        wins: 0,
        losses: 0,
        draws: 0,
        avatar: null
      });
    } else {
      if (users.has(username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      users.set(username, { username, password: hashedPassword, wins: 0, losses: 0, draws: 0 });
      saveUsers();
    }

    res.json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
   try {
     const { username, password } = req.body;

     let user;
     if (useFirebase) {
       const userDoc = await db.collection('users').doc(username).get();
       if (!userDoc.exists) {
         return res.status(401).json({ error: 'Invalid credentials' });
       }
       user = userDoc.data();
     } else {
       user = users.get(username);
     }

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
    let leaderboard;
    if (useFirebase) {
      const usersSnapshot = await db.collection('users').orderBy('wins', 'desc').limit(10).get();
      leaderboard = usersSnapshot.docs.map(doc => {
        const data = doc.data();
        return { username: data.username, wins: data.wins, losses: data.losses, draws: data.draws };
      });
    } else {
      leaderboard = Array.from(users.values())
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 10)
        .map(({ username, wins, losses, draws }) => ({ username, wins, losses, draws }));
    }
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
      let user;
      if (useFirebase) {
        const userDoc = await db.collection('users').doc(decoded.username).get();
        if (userDoc.exists) {
          user = userDoc.data();
        }
      } else {
        user = users.get(decoded.username);
      }
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
          currentPlayer: null,
          gameState: 'rps',
          lastWinner: null,
          lastLoser: null,
          rpsChoices: {},
          moveTimer: null,
          timeLeft: 5,
          isFirstGame: true
        });

        [challengerUser.socketId, socket.id].forEach(socketId => {
          io.to(socketId).emit('rpsStart', {
            roomId,
            players: gameRooms.get(roomId).players
          });
        });
      } else {
        io.to(challengerUser?.socketId).emit('challengeDeclined', challenge.challenged);
      }
      challenges.delete(challengeId);
    }
  });

  socket.on('rpsChoice', ({ roomId, choice }) => {
    const room = gameRooms.get(roomId);
    if (room && room.gameState === 'rps' && room.players[socket.username]) {
      room.rpsChoices[socket.username] = choice;
      
      // Check if both players made their choice
      if (Object.keys(room.rpsChoices).length === 2) {
        const players = Object.keys(room.players);
        const [player1, player2] = players;
        const choice1 = room.rpsChoices[player1];
        const choice2 = room.rpsChoices[player2];
        
        let winner = null;
        if (choice1 === choice2) {
          // Tie - random winner
          winner = Math.random() < 0.5 ? player1 : player2;
        } else if (
          (choice1 === 'rock' && choice2 === 'scissors') ||
          (choice1 === 'paper' && choice2 === 'rock') ||
          (choice1 === 'scissors' && choice2 === 'paper')
        ) {
          winner = player1;
        } else {
          winner = player2;
        }
        
        room.currentPlayer = winner;
        room.gameState = 'playing';
        
        Object.values(room.players).forEach(player => {
          io.to(player.socketId).emit('rpsResult', {
            choices: room.rpsChoices,
            winner: winner
          });
        });
        
        setTimeout(() => {
          Object.values(room.players).forEach(player => {
            io.to(player.socketId).emit('gameStart', {
              roomId,
              players: room.players,
              currentPlayer: room.currentPlayer,
              board: room.board
            });
          });
          startMoveTimer(roomId);
        }, 3000);
      }
    }
  });

  socket.on('makeMove', async ({ roomId, position }) => {
    const room = gameRooms.get(roomId);
    if (room && room.currentPlayer === socket.username && room.board[position] === null) {
      room.board[position] = room.players[socket.username].symbol;
      
      const winner = checkWinner(room.board, room);
      const isDraw = !winner && room.board.every(cell => cell !== null);
      
      if (winner || isDraw) {
        room.gameState = winner ? 'finished' : 'draw';
        if (winner) {
          const loser = Object.keys(room.players).find(p => p !== winner);
          room.lastWinner = winner;
          room.lastLoser = loser;

          if (useFirebase) {
            await db.collection('users').doc(winner).update({ wins: admin.firestore.FieldValue.increment(1) });
            await db.collection('users').doc(loser).update({ losses: admin.firestore.FieldValue.increment(1) });
          } else {
            const winnerUser = users.get(winner);
            const loserUser = users.get(loser);
            if (winnerUser) winnerUser.wins++;
            if (loserUser) loserUser.losses++;
            saveUsers();
          }
        } else {
          if (useFirebase) {
            await Promise.all(Object.keys(room.players).map(player =>
              db.collection('users').doc(player).update({ draws: admin.firestore.FieldValue.increment(1) })
            ));
          } else {
            Object.keys(room.players).forEach(player => {
              const user = users.get(player);
              if (user) user.draws++;
            });
            saveUsers();
          }
        }
      } else {
        room.currentPlayer = Object.keys(room.players).find(p => p !== socket.username);
        startMoveTimer(roomId);
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
          // Reset game state
          room.board = Array(9).fill(null);
          room.timeLeft = 5;
          clearTimeout(room.moveTimer);
          room.rematchRequests.clear();
          room.isFirstGame = false;
          
          // Determine first player: loser goes first, or RPS if first game/draw
          if (room.lastLoser) {
            room.currentPlayer = room.lastLoser;
            room.gameState = 'playing';
            
            Object.values(room.players).forEach(player => {
              io.to(player.socketId).emit('gameStart', {
                roomId,
                players: room.players,
                currentPlayer: room.currentPlayer,
                board: room.board
              });
            });
            startMoveTimer(roomId);
          } else {
            // First game or previous draw - use RPS
            room.gameState = 'rps';
            room.currentPlayer = null;
            room.rpsChoices = {};
            
            Object.values(room.players).forEach(player => {
              io.to(player.socketId).emit('rpsStart', {
                roomId,
                players: room.players
              });
            });
          }
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
        if (useFirebase) {
          await db.collection('users').doc(socket.username).update({ avatar });
        } else {
          const user = users.get(socket.username);
          if (user) {
            user.avatar = avatar;
            saveUsers();
          }
        }
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
          currentPlayer: null,
          gameState: 'rps',
          lastWinner: null,
          lastLoser: null,
          rpsChoices: {},
          moveTimer: null,
          timeLeft: 5,
          isFirstGame: true
        });
        
        // Start RPS mini-game for both players
        Object.values(match.players).forEach(player => {
          io.to(player.socketId).emit('rpsStart', {
            roomId: matchId,
            players: match.players
          });
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

async function startMoveTimer(roomId) {
  const room = gameRooms.get(roomId);
  if (!room || room.gameState !== 'playing') return;

  room.timeLeft = 5;
  clearTimeout(room.moveTimer);

  const timer = setInterval(async () => {
    room.timeLeft--;

    Object.values(room.players).forEach(player => {
      io.to(player.socketId).emit('timerUpdate', {
        timeLeft: room.timeLeft,
        currentPlayer: room.currentPlayer
      });
    });

    if (room.timeLeft <= 0) {
      clearInterval(timer);
      // Auto-move for current player (random empty cell)
      const emptyCells = room.board.map((cell, index) => cell === null ? index : null).filter(i => i !== null);
      if (emptyCells.length > 0) {
        const randomMove = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        room.board[randomMove] = room.players[room.currentPlayer].symbol;

        const winner = checkWinner(room.board, room);
        const isDraw = !winner && room.board.every(cell => cell !== null);

        if (winner || isDraw) {
          room.gameState = winner ? 'finished' : 'draw';
          if (winner) {
            if (useFirebase) {
              await db.collection('users').doc(winner).update({ wins: admin.firestore.FieldValue.increment(1) });
              const loser = Object.keys(room.players).find(p => p !== winner);
              await db.collection('users').doc(loser).update({ losses: admin.firestore.FieldValue.increment(1) });
            } else {
              const winnerUser = users.get(winner);
              const loser = Object.keys(room.players).find(p => p !== winner);
              const loserUser = users.get(loser);
              if (winnerUser) winnerUser.wins++;
              if (loserUser) loserUser.losses++;
              saveUsers();
            }
            room.lastWinner = winner;
          } else {
            if (useFirebase) {
              await Promise.all(Object.keys(room.players).map(player =>
                db.collection('users').doc(player).update({ draws: admin.firestore.FieldValue.increment(1) })
              ));
            } else {
              Object.keys(room.players).forEach(player => {
                const user = users.get(player);
                if (user) user.draws++;
              });
              saveUsers();
            }
          }
        } else {
          room.currentPlayer = Object.keys(room.players).find(p => p !== room.currentPlayer);
          startMoveTimer(roomId);
        }

        Object.values(room.players).forEach(player => {
          io.to(player.socketId).emit('gameUpdate', {
            board: room.board,
            currentPlayer: room.currentPlayer,
            gameState: room.gameState,
            winner: winner,
            isDraw: isDraw,
            autoMove: true
          });
        });
      }
    }
  }, 1000);

  room.moveTimer = timer;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});