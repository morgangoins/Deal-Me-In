const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket'] // Force WebSocket for now
});

app.use(express.static('public'));

const gameState = {
    players: [],
    communityCards: [],
    gameStage: 'waiting',
    pot: 0,
    currentPlayerIndex: 0,
    dealerIndex: 0,
    hasBetThisRound: new Set(),
    pastHands: [],
    currentHandBets: { preflop: [], flop: [], turn: [], river: [] },
    spectators: 0,
    smallBlind: 5,
    bigBlind: 10,
    deck: [],
    seats: Array(8).fill(null)
};

function shuffleDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    gameState.deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            gameState.deck.push(rank + suit);
        }
    }
    for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
    }
    console.log('Deck shuffled');
}

function dealCards() {
    if (gameState.deck.length < gameState.players.length * 2 + 5) {
        shuffleDeck();
    }
    gameState.players.forEach(player => {
        player.cards = [gameState.deck.pop(), gameState.deck.pop()];
    });
    gameState.gameStage = 'preflop';
}

function advanceStage() {
    gameState.hasBetThisRound.clear();
    switch (gameState.gameStage) {
        case 'preflop':
            gameState.communityCards = [gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop()];
            gameState.gameStage = 'flop';
            break;
        case 'flop':
            gameState.communityCards.push(gameState.deck.pop());
            gameState.gameStage = 'turn';
            break;
        case 'turn':
            gameState.communityCards.push(gameState.deck.pop());
            gameState.gameStage = 'river';
            break;
        case 'river':
            determineWinner();
            gameState.gameStage = 'showdown';
            break;
        case 'showdown':
            startNewHand();
            break;
    }
}

function determineWinner() {
    const winnerIndex = Math.floor(Math.random() * gameState.players.length);
    gameState.players[winnerIndex].chips += gameState.pot;
    gameState.pastHands.push({
        winner: gameState.players[winnerIndex].name,
        pot: gameState.pot,
        communityCards: [...gameState.communityCards],
        bets: { ...gameState.currentHandBets },
        players: gameState.players.map(p => ({ name: p.name, cards: [...p.cards], chips: p.chips }))
    });
    gameState.pot = 0;
    gameState.currentPlayerIndex = winnerIndex;
}

function startNewHand() {
    gameState.communityCards = [];
    gameState.currentHandBets = { preflop: [], flop: [], turn: [], river: [] };
    gameState.hasBetThisRound.clear();
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    gameState.currentPlayerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    
    const smallBlindIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    const bigBlindIndex = (gameState.dealerIndex + 2) % gameState.players.length;
    gameState.players[smallBlindIndex].chips -= gameState.smallBlind;
    gameState.players[bigBlindIndex].chips -= gameState.bigBlind;
    gameState.pot += gameState.smallBlind + gameState.bigBlind;
    gameState.currentHandBets.preflop.push(
        { player: gameState.players[smallBlindIndex].name, amount: gameState.smallBlind },
        { player: gameState.players[bigBlindIndex].name, amount: gameState.bigBlind }
    );
    gameState.hasBetThisRound.add(gameState.players[smallBlindIndex].id);
    gameState.hasBetThisRound.add(gameState.players[bigBlindIndex].id);
    
    dealCards();
    io.emit('update', prepareGameStateForClient());
}

// Convert gameState for client (serialize Sets to arrays)
function prepareGameStateForClient() {
    return {
        ...gameState,
        hasBetThisRound: Array.from(gameState.hasBetThisRound)
    };
}

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    gameState.spectators++;
    io.emit('update', prepareGameStateForClient());

    socket.on('sitDown', ({ name, chips, seat }) => {
        console.log(`Sit down attempt: ${name} at seat ${seat}`);
        if (gameState.seats[seat] === null && gameState.players.length < 8) {
            const player = { id: socket.id, name, chips, cards: [], seat };
            gameState.seats[seat] = player;
            gameState.players = gameState.seats.filter(p => p !== null);
            gameState.spectators--;
            if (gameState.players.length >= 2 && gameState.gameStage === 'waiting') {
                startNewHand();
            } else {
                io.emit('update', prepareGameStateForClient());
            }
        }
    });

    socket.on('bet', (data) => {
        const amount = data.amount || (data.auto ? (data.playerIndex === (gameState.dealerIndex + 1) % gameState.players.length ? gameState.smallBlind : gameState.bigBlind) : 0);
        const playerIndex = data.playerIndex !== undefined ? data.playerIndex : gameState.players.findIndex(p => p.id === socket.id);
        const player = gameState.players[playerIndex];
        if (!player || gameState.hasBetThisRound.has(player.id) || amount > player.chips) return;
        
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        io.emit('update', prepareGameStateForClient());
    });

    socket.on('check', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        gameState.hasBetThisRound.add(player.id);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        io.emit('update', prepareGameStateForClient());
    });

    socket.on('fold', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;
        
        gameState.seats[gameState.players[playerIndex].seat] = null;
        gameState.players.splice(playerIndex, 1);
        gameState.currentPlayerIndex = gameState.currentPlayerIndex % gameState.players.length;
        
        if (gameState.players.length === 1) {
            determineWinner();
            gameState.gameStage = 'showdown';
        }
        io.emit('update', prepareGameStateForClient());
    });

    socket.on('advance', () => {
        if (gameState.hasBetThisRound.size === gameState.players.length) {
            advanceStage();
        }
    });

    socket.on('voiceSignal', (data) => {
        if (data.to) {
            io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
        } else {
            socket.broadcast.emit('voiceSignal', { from: socket.id, signal: data.signal });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameState.seats[gameState.players[playerIndex].seat] = null;
            gameState.players.splice(playerIndex, 1);
        } else {
            gameState.spectators--;
        }
        io.emit('update', prepareGameStateForClient());
    });

    socket.on('error', (error) => {
        console.error(`Socket error: ${error.message}`);
    });
});

shuffleDeck();
server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on http://localhost:3000');
});