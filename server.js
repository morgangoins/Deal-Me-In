// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // Serve your static files from 'public' directory

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
    seats: Array(8).fill(null) // 8 seats, null means open
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
    // Fisher-Yates shuffle
    for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
    }
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
    // Simplified winner determination (you might want to implement proper poker hand evaluation)
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
    
    // Post blinds
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
    io.emit('update', gameState);
}

io.on('connection', (socket) => {
    gameState.spectators++;
    io.emit('update', gameState);

    socket.on('sitDown', ({ name, chips, seat }) => {
        if (gameState.seats[seat] === null && gameState.players.length < 8) {
            const player = {
                id: socket.id,
                name,
                chips,
                cards: [],
                seat
            };
            gameState.seats[seat] = player;
            gameState.players = gameState.seats.filter(p => p !== null);
            gameState.spectators--;
            if (gameState.players.length >= 2 && gameState.gameStage === 'waiting') {
                startNewHand();
            }
            io.emit('update', gameState);
        }
    });

    socket.on('bet', (amount, auto = false) => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || gameState.hasBetThisRound.has(player.id) || amount > player.chips) return;
        
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        io.emit('update', gameState);
    });

    socket.on('check', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        gameState.hasBetThisRound.add(player.id);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        io.emit('update', gameState);
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
        io.emit('update', gameState);
    });

    socket.on('advance', () => {
        if (gameState.hasBetThisRound.size === gameState.players.length) {
            advanceStage();
            io.emit('update', gameState);
        }
    });

    socket.on('disconnect', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameState.seats[gameState.players[playerIndex].seat] = null;
            gameState.players.splice(playerIndex, 1);
        } else {
            gameState.spectators--;
        }
        io.emit('update', gameState);
    });
});

shuffleDeck();
server.listen(3000, () => {
    console.log('Server running on port 3000');
});