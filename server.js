const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// Rest of your gameState and functions remain the same until io.on('connection')

io.on('connection', (socket) => {
    gameState.spectators++;
    io.emit('update', gameState);

    socket.on('sitDown', ({ name, chips, seat }) => {
        // Same as before
    });

    socket.on('bet', (data) => {
        // Handle bet as before, ensuring data.amount is used
        const amount = data.amount || (data.auto ? (data.playerIndex === (gameState.dealerIndex + 1) % gameState.players.length ? gameState.smallBlind : gameState.bigBlind) : 0);
        const playerIndex = data.playerIndex !== undefined ? data.playerIndex : gameState.players.findIndex(p => p.id === socket.id);
        const player = gameState.players[playerIndex];
        if (!player || gameState.hasBetThisRound.has(player.id) || amount > player.chips) return;
        
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        io.emit('update', gameState);
    });

    // Rest of your socket handlers (check, fold, advance) remain the same

    socket.on('voiceSignal', (data) => {
        if (data.to) {
            io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
        } else {
            socket.broadcast.emit('voiceSignal', { from: socket.id, signal: data.signal });
        }
    });

    socket.on('disconnect', () => {
        // Same as before
    });
});

shuffleDeck();
server.listen(3000, () => {
    console.log('Server running on port 3000');
});