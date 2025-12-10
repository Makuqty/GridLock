const socket = io();
let currentUser = null;
let currentRoom = null;
let currentChallenge = null;
let targetPlayer = null;
let isSearchingMatch = false;

// Auth functions
function showLogin() {
    document.querySelector('.tab-btn.active').classList.remove('active');
    document.querySelector('.tab-btn').classList.add('active');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
}

function showRegister() {
    document.querySelector('.tab-btn.active').classList.remove('active');
    document.querySelectorAll('.tab-btn')[1].classList.add('active');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (response.ok) {
            localStorage.setItem('token', data.token);
            currentUser = data.user;
            socket.emit('authenticate', data.token);
        } else {
            alert(data.error);
        }
    } catch (error) {
        alert('Login failed');
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('registerUsername').value;
    const password = document.getElementById('registerPassword').value;
    
    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (response.ok) {
            alert('Registration successful! Please login.');
            showLogin();
        } else {
            alert(data.error);
        }
    } catch (error) {
        alert('Registration failed');
    }
});

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
    showScreen('authScreen');
}

// Screen management
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
}

// Socket events
socket.on('authenticated', (user) => {
    currentUser = user;
    showScreen('lobbyScreen');
    updateUserProfile();
    loadLeaderboard();
});

socket.on('avatarUpdated', (avatar) => {
    currentUser.avatar = avatar;
    updateUserProfile();
});

socket.on('authError', (error) => {
    alert(error);
    logout();
});

socket.on('onlineUsers', (users) => {
    updateOnlineUsers(users);
});

socket.on('challengeReceived', (challenge) => {
    currentChallenge = challenge;
    document.getElementById('challengeText').textContent = 
        `${challenge.challenger} challenged you to a game!`;
    document.getElementById('challengeReceivedModal').classList.add('active');
});

socket.on('challengeDeclined', (username) => {
    alert(`${username} declined your challenge`);
});

socket.on('rpsStart', (data) => {
    currentRoom = data.roomId;
    showScreen('rpsScreen');
    document.getElementById('rpsStatus').textContent = 'Choose your move!';

    // Reset RPS buttons
    document.querySelectorAll('.rps-btn').forEach(btn => {
        btn.disabled = false;
        btn.style.background = '';
    });
});

socket.on('rpsResult', (data) => {
    const { choices, winner, isDraw } = data;
    const players = Object.keys(choices);

    if (isDraw) {
        document.getElementById('rpsStatus').innerHTML = `
            <div>Results:</div>
            <div>${players[0]}: ${choices[players[0]]}</div>
            <div>${players[1]}: ${choices[players[1]]}</div>
            <div><strong>It's a draw! Try again!</strong></div>
        `;

        setTimeout(() => {
            document.getElementById('rpsStatus').textContent = 'Restarting Rock Paper Scissors...';
        }, 2000);
    } else {
        const isWinner = winner === currentUser.username;

        document.getElementById('rpsStatus').innerHTML = `
            <div>Results:</div>
            <div>${players[0]}: ${choices[players[0]]}</div>
            <div>${players[1]}: ${choices[players[1]]}</div>
            <div><strong>${winner} goes first!</strong></div>
        `;

        setTimeout(() => {
            document.getElementById('rpsStatus').textContent = 'Starting game...';
        }, 2000);
    }
});

socket.on('gameStart', (gameData) => {
    currentRoom = gameData.roomId;
    showScreen('gameScreen');
    initializeGame(gameData);
    // Reset rematch button state
    const rematchBtn = document.getElementById('rematchBtn');
    rematchBtn.style.display = 'none';
    rematchBtn.textContent = 'Rematch';
    rematchBtn.disabled = false;
});

socket.on('timerUpdate', (data) => {
    updateTimer(data.timeLeft, data.currentPlayer);
});

socket.on('gameUpdate', (gameData) => {
    updateGameBoard(gameData);
});

socket.on('messageReceived', (messageData) => {
    addChatMessage(messageData);
});

socket.on('rematchRequested', (requester) => {
    console.log('Rematch requested by:', requester);
    const modal = document.getElementById('rematchRequestModal');
    const text = document.getElementById('rematchRequestText');
    
    if (modal && text) {
        text.textContent = `${requester} wants a rematch!`;
        modal.classList.add('active');
        console.log('Rematch modal should be visible');
    } else {
        console.error('Rematch modal elements not found');
        alert(`${requester} wants a rematch!`);
    }
});

socket.on('rematchDeclined', (decliner) => {
    alert(`${decliner} declined the rematch`);
    document.getElementById('rematchBtn').textContent = 'Rematch';
    document.getElementById('rematchBtn').disabled = false;
});

socket.on('matchFound', (matchData) => {
    isSearchingMatch = false;
    updateFindMatchButton();
    currentChallenge = { challengeId: matchData.matchId, challenger: matchData.opponent };
    document.getElementById('matchText').textContent = 
        `Match found! Playing against ${matchData.opponent}. Choose your symbol:`;
    document.getElementById('matchSymbolModal').classList.add('active');
});

function chooseMatchSymbol(symbol) {
    socket.emit('matchSymbolChosen', { 
        matchId: currentChallenge.challengeId, 
        symbol: symbol 
    });
}

socket.on('symbolTaken', (symbol) => {
    alert(`Symbol ${symbol} is already taken by your opponent. Please choose another.`);
});

socket.on('symbolAccepted', () => {
    document.getElementById('matchSymbolModal').classList.remove('active');
    currentChallenge = null;
});

// Lobby functions
function updateUserProfile() {
    const profileBtn = document.getElementById('userProfile');
    if (profileBtn) {
        profileBtn.textContent = currentUser.username;
    }

    // Update dashboard stats
    const userWins = document.getElementById('userWins');
    const userLosses = document.getElementById('userLosses');
    const userDraws = document.getElementById('userDraws');

    if (userWins) userWins.textContent = currentUser.wins || 0;
    if (userLosses) userLosses.textContent = currentUser.losses || 0;
    if (userDraws) userDraws.textContent = currentUser.draws || 0;
}

function updateOnlineUsers(users) {
    const container = document.getElementById('onlinePlayersList');
    container.innerHTML = '';
    
    users.forEach(user => {
        if (user.username !== currentUser.username) {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-item';
            playerDiv.innerHTML = `
                <span>${user.username}</span>
                <button class="challenge-btn" onclick="challengePlayer('${user.username}')">Challenge</button>
            `;
            container.appendChild(playerDiv);
        }
    });
}

async function loadLeaderboard() {
    try {
        const response = await fetch('/api/leaderboard');
        const leaderboard = await response.json();
        
        const container = document.getElementById('leaderboard');
        container.innerHTML = '';
        
        leaderboard.forEach((player, index) => {
            const rank = index + 1;
            let rankIcon = '';

            if (rank === 1) {
                rankIcon = '<i class="bi bi-trophy-fill" style="color: #ffd700;"></i>';
            } else if (rank === 2) {
                rankIcon = '<i class="bi bi-award-fill" style="color: #c0c0c0;"></i>';
            } else if (rank === 3) {
                rankIcon = '<i class="bi bi-award-fill" style="color: #cd7f32;"></i>';
            } else {
                rankIcon = '<i class="bi bi-award" style="color: #64748b;"></i>';
            }

            const playerDiv = document.createElement('div');
            playerDiv.className = `leaderboard-item rank-${rank}`;
            playerDiv.innerHTML = `
                <span class="player-name">
                    <span class="rank-icon">${rankIcon}</span>
                    <span class="rank-number">${rank}.</span>
                    <span class="username">${player.username}</span>
                </span>
                <div class="leaderboard-stats">
                    <span>W:${player.wins}</span>
                    <span>L:${player.losses}</span>
                    <span>D:${player.draws}</span>
                </div>
            `;
            container.appendChild(playerDiv);
        });
    } catch (error) {
        console.error('Failed to load leaderboard');
    }
}

// Challenge functions
function challengePlayer(username) {
    targetPlayer = username;
    document.getElementById('challengeModal').classList.add('active');
}

function sendChallenge(symbol) {
    socket.emit('sendChallenge', { targetUsername: targetPlayer, symbol });
    document.getElementById('challengeModal').classList.remove('active');
    targetPlayer = null;
}

function showSymbolChoice() {
    document.getElementById('challengeText').textContent = 'Choose your symbol:';
    document.getElementById('challengeInitialActions').style.display = 'none';
    document.getElementById('challengeSymbolChoice').style.display = 'grid';
}

function acceptChallengeWithSymbol(symbol) {
    socket.emit('respondToChallenge', { 
        challengeId: currentChallenge.challengeId, 
        accepted: true, 
        symbol: symbol 
    });
    document.getElementById('challengeReceivedModal').classList.remove('active');
    document.getElementById('challengeInitialActions').style.display = 'flex';
    document.getElementById('challengeSymbolChoice').style.display = 'none';
    currentChallenge = null;
}

function respondToChallenge(accepted) {
    socket.emit('respondToChallenge', { challengeId: currentChallenge.challengeId, accepted });
    document.getElementById('challengeReceivedModal').classList.remove('active');
    document.getElementById('challengeInitialActions').style.display = 'flex';
    document.getElementById('challengeSymbolChoice').style.display = 'none';
    currentChallenge = null;
}

// Game functions
function initializeGame(gameData) {
    const board = document.getElementById('gameBoard');
    board.innerHTML = '';
    
    for (let i = 0; i < 9; i++) {
        const cell = document.createElement('button');
        cell.className = 'cell';
        cell.setAttribute('aria-label', `Cell ${i + 1}`);
        cell.onclick = () => makeMove(i);
        
        // Add touch handling for better mobile experience
        cell.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (!cell.disabled) {
                cell.style.transform = 'scale(0.95)';
            }
        });
        
        cell.addEventListener('touchend', (e) => {
            e.preventDefault();
            cell.style.transform = '';
            if (!cell.disabled) {
                makeMove(i);
            }
        });
        
        cell.addEventListener('touchcancel', () => {
            cell.style.transform = '';
        });
        
        board.appendChild(cell);
    }
    
    updateGameStatus(gameData.currentPlayer);
    document.getElementById('chatMessages').innerHTML = '';
}

function updateGameStatus(currentPlayer) {
    const statusText = currentPlayer === currentUser.username ? 'Your turn' : `${currentPlayer}'s turn`;
    document.getElementById('gameStatus').innerHTML = `
        <div>${statusText}</div>
        <div id="timer" class="timer"></div>
    `;
}

function updateTimer(timeLeft, currentPlayer) {
    const timerEl = document.getElementById('timer');
    if (timerEl) {
        const isMyTurn = currentPlayer === currentUser.username;
        timerEl.textContent = `Time: ${timeLeft}s`;
        timerEl.className = `timer ${timeLeft <= 10 ? 'warning' : ''} ${isMyTurn ? 'my-turn' : ''}`;
    }
}

function updateGameBoard(gameData) {
    const cells = document.querySelectorAll('.cell');
    
    gameData.board.forEach((symbol, index) => {
        if (symbol) {
            let symbolClass = symbol.toLowerCase();
            if (symbol === '⭐') symbolClass = 'star';
            else if (symbol === '🔥') symbolClass = 'fire';
            else if (symbol === '⚡') symbolClass = 'lightning';
            else if (symbol === '💎') symbolClass = 'diamond';
            
            if (['fun', 'giga', 'kupal', 'lol', 'suck', 'troll', 'isu', 'ccsict'].includes(symbol)) {
                cells[index].innerHTML = `<img src="images/${symbol}.jpg" alt="${symbol}">`;
            } else {
                cells[index].textContent = symbol;
            }
            
            cells[index].className = `cell ${symbolClass}`;
            cells[index].disabled = true;
            cells[index].setAttribute('aria-label', `Cell ${index + 1}, ${symbol}`);
        }
    });
    
    if (gameData.gameState === 'playing') {
        cells.forEach((cell, index) => {
            if (!gameData.board[index]) {
                cell.disabled = gameData.currentPlayer !== currentUser.username;
                const isYourTurn = gameData.currentPlayer === currentUser.username;
                cell.setAttribute('aria-label', 
                    `Cell ${index + 1}, ${isYourTurn ? 'your turn' : 'waiting for opponent'}`);
            }
        });
        updateGameStatus(gameData.currentPlayer);
        
        if (gameData.autoMove) {
            showGameEndNotification('Time up! Auto-move made.');
        }
    } else {
        cells.forEach(cell => cell.disabled = true);
        
        let message = '';
        if (gameData.winner) {
            message = gameData.winner === currentUser.username ? 'You won! 🎉' : `${gameData.winner} won! 😔`;
        } else if (gameData.isDraw) {
            message = "It's a draw! 🤝";
        }
        
        document.getElementById('gameStatus').innerHTML = message;
        document.getElementById('rematchBtn').style.display = 'inline-block';
        
        // Show popup notification
        if (message) {
            showGameEndNotification(message);
        }
    }
}

// Improved game end notification
function showGameEndNotification(message) {
    const isWin = message.includes('You won');
    const isDraw = message.includes('draw');
    
    const notification = document.createElement('div');
    notification.className = 'game-notification';
    
    let bgColor, borderColor, icon;
    if (isWin) {
        bgColor = 'linear-gradient(135deg, #4ecdc4, #44a08d)';
        borderColor = '#4ecdc4';
        icon = '<i class="bi bi-trophy-fill"></i>';
    } else if (isDraw) {
        bgColor = 'linear-gradient(135deg, #f39c12, #e67e22)';
        borderColor = '#f39c12';
        icon = '<i class="bi bi-hand-thumbs-up-fill"></i>';
    } else {
        bgColor = 'linear-gradient(135deg, #e74c3c, #c0392b)';
        borderColor = '#e74c3c';
        icon = '<i class="bi bi-heartbreak-fill"></i>';
    }
    
    notification.innerHTML = `
        <div class="notification-icon">${icon}</div>
        <div class="notification-text">${message}</div>
    `;
    
    notification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0);
        background: ${bgColor};
        color: white;
        padding: 30px 40px;
        border-radius: 20px;
        font-size: 20px;
        font-weight: bold;
        z-index: 10000;
        text-align: center;
        backdrop-filter: blur(15px);
        border: 3px solid ${borderColor};
        box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 20px ${borderColor}40;
        animation: gameEndPop 2s ease-in-out forwards;
        min-width: 300px;
    `;
    
    document.body.appendChild(notification);
    
    // Add enhanced CSS animation
    if (!document.getElementById('gameEndStyles')) {
        const style = document.createElement('style');
        style.id = 'gameEndStyles';
        style.textContent = `
            @keyframes gameEndPop {
                0% { 
                    opacity: 0; 
                    transform: translate(-50%, -50%) scale(0) rotate(-10deg);
                }
                15% { 
                    opacity: 1; 
                    transform: translate(-50%, -50%) scale(1.1) rotate(2deg);
                }
                25% { 
                    transform: translate(-50%, -50%) scale(1) rotate(0deg);
                }
                85% { 
                    opacity: 1; 
                    transform: translate(-50%, -50%) scale(1) rotate(0deg);
                }
                100% { 
                    opacity: 0; 
                    transform: translate(-50%, -50%) scale(0.8) rotate(5deg);
                }
            }
            .notification-icon {
                font-size: 3rem;
                margin-bottom: 10px;
                animation: bounce 0.6s ease-in-out 0.2s;
            }
            .notification-text {
                font-size: 1.2rem;
            }
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
            }
        `;
        document.head.appendChild(style);
    }
    
    setTimeout(() => {
        if (document.body.contains(notification)) {
            document.body.removeChild(notification);
        }
    }, 2000);
}



function makeMove(position) {
    const cell = document.querySelectorAll('.cell')[position];
    if (!cell.disabled && currentRoom) {
        socket.emit('makeMove', { roomId: currentRoom, position });
    }
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message && currentRoom) {
        socket.emit('sendMessage', { roomId: currentRoom, message });
        input.value = '';
        document.getElementById('emotePicker').classList.add('hidden');
    }
}

function toggleEmotePicker() {
    const picker = document.getElementById('emotePicker');
    picker.classList.toggle('hidden');
}

function addEmote(emote) {
    const input = document.getElementById('messageInput');
    input.value += emote;
    input.focus();
    document.getElementById('emotePicker').classList.add('hidden');
}

function addChatMessage(messageData) {
    const container = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    const isOwnMessage = messageData.username === currentUser.username;
    
    messageDiv.className = `message ${isOwnMessage ? 'own' : 'other'}`;
    messageDiv.innerHTML = `
        <div class="message-bubble">
            <div class="message-text">${messageData.message}</div>
            <div class="message-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
        </div>
        ${!isOwnMessage ? `<div class="message-sender">${messageData.username}</div>` : ''}
    `;
    
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
}

function requestRematch() {
    socket.emit('requestRematch', { roomId: currentRoom });
    document.getElementById('rematchBtn').textContent = 'Rematch Requested...';
    document.getElementById('rematchBtn').disabled = true;
}

function respondToRematch(accepted) {
    socket.emit('respondToRematch', { roomId: currentRoom, accepted });
    document.getElementById('rematchRequestModal').classList.remove('active');
}

function makeRPSChoice(choice) {
    socket.emit('rpsChoice', { roomId: currentRoom, choice });
    document.getElementById('rpsStatus').textContent = 'Waiting for opponent...';
    
    // Disable buttons after choice
    document.querySelectorAll('.rps-btn').forEach(btn => {
        btn.disabled = true;
        if (btn.dataset.choice === choice) {
            btn.style.background = '#4CAF50';
        }
    });
}

function leaveRPS() {
    socket.emit('leaveGame', { roomId: currentRoom });
    currentRoom = null;
    showScreen('lobbyScreen');
    loadLeaderboard();
}

function leaveGame() {
    socket.emit('leaveGame', { roomId: currentRoom });
    currentRoom = null;
    showScreen('lobbyScreen');
    loadLeaderboard();
}

// Enter key support for chat and better mobile handling
document.getElementById('messageInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

// Prevent double-tap zoom on buttons
document.addEventListener('DOMContentLoaded', () => {
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
        const now = (new Date()).getTime();
        if (now - lastTouchEnd <= 300) {
            e.preventDefault();
        }
        lastTouchEnd = now;
    }, false);
    
    // Add visual feedback for all buttons
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => {
        button.addEventListener('touchstart', () => {
            button.style.opacity = '0.8';
        });
        
        button.addEventListener('touchend', () => {
            setTimeout(() => {
                button.style.opacity = '';
            }, 150);
        });
        
        button.addEventListener('touchcancel', () => {
            button.style.opacity = '';
        });
    });
});

// Handle orientation changes
window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        // Force a repaint to handle any layout issues
        document.body.style.display = 'none';
        document.body.offsetHeight; // Trigger reflow
        document.body.style.display = '';
    }, 100);
});

// Improve focus management for keyboard users
document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
        document.body.classList.add('keyboard-navigation');
    }
});

document.addEventListener('mousedown', () => {
    document.body.classList.remove('keyboard-navigation');
});

// Profile functions
function showProfile() {
    const totalGames = currentUser.wins + currentUser.losses + currentUser.draws;
    const winRate = totalGames > 0 ? Math.round((currentUser.wins / totalGames) * 100) : 0;
    
    document.getElementById('profileUsername').textContent = currentUser.username;
    document.getElementById('profileWins').textContent = currentUser.wins;
    document.getElementById('profileLosses').textContent = currentUser.losses;
    document.getElementById('profileDraws').textContent = currentUser.draws;
    document.getElementById('profileWinRate').textContent = `${winRate}%`;
    
    document.getElementById('profileModal').classList.add('active');
}

function closeProfile() {
    document.getElementById('profileModal').classList.remove('active');
}

function changeAvatar() {
    document.getElementById('avatarModal').classList.add('active');
}

function selectAvatar(avatar) {
    currentUser.avatar = avatar;
    socket.emit('updateAvatar', avatar);
    document.getElementById('avatarModal').classList.remove('active');
    const iconClass = getAvatarIcon(avatar);
    document.getElementById('profileAvatar').innerHTML = `<i class="bi ${iconClass}"></i>`;
    updateUserProfile();
}

function requestRematch() {
    socket.emit('requestRematch', { roomId: currentRoom });
    document.getElementById('rematchBtn').textContent = 'Rematch Requested...';
    document.getElementById('rematchBtn').disabled = true;
}

function respondToRematch(accepted) {
    socket.emit('respondToRematch', { roomId: currentRoom, accepted });
    document.getElementById('rematchRequestModal').classList.remove('active');
}

// Find Match functions
function findMatch() {
    if (isSearchingMatch) {
        socket.emit('cancelMatchmaking');
        isSearchingMatch = false;
    } else {
        socket.emit('findMatch');
        isSearchingMatch = true;
    }
    updateFindMatchButton();
}

function updateFindMatchButton() {
    const btn = document.getElementById('findMatchBtn');
    if (isSearchingMatch) {
        btn.textContent = 'Cancel Search';
        btn.classList.add('searching');
    } else {
        btn.textContent = 'Find Match';
        btn.classList.remove('searching');
    }
}

// Navigation functions removed - all sections are now visible on single page

function getAvatarIcon(avatar) {
    const iconMap = {
        'controller': 'bi-controller',
        'bullseye': 'bi-bullseye',
        'dice': 'bi-dice-6',
        'trophy': 'bi-trophy',
        'star': 'bi-star-fill',
        'fire': 'bi-fire',
        'lightning': 'bi-lightning-fill',
        'gem': 'bi-gem'
    };
    return iconMap[avatar] || 'bi-controller';
}

// Auto-login if token exists
window.addEventListener('load', () => {
    const token = localStorage.getItem('token');
    if (token) {
        socket.emit('authenticate', token);
    }
});