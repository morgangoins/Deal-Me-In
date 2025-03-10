const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public')); // Serve files from 'public' folder

const suits = ['♠', '♣', '♥', '♦'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
let deck = [];

function shuffleDeck() {
    deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push(rank + suit);
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

let gameState = {
    players: [],
    communityCards: [],
    gameStage: 'waiting',
    pot: 0,
    currentPlayerIndex: 0,
    dealerIndex: 0,
    hasBetThisRound: new Set(),
    pastHands: [],
    currentHandBets: { preflop: [], flop: [], turn: [], river: [] }
};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('sitDown', ({ name, chips }) => {
        if (gameState.players.length < 6) {
            gameState.players.push({ id: socket.id, name, chips, cards: [] });
            if (gameState.players.length === 1) startGame();
            io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
        }
    });

    socket.on('bet', (amount) => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (player && gameState.currentPlayerIndex === gameState.players.indexOf(player) && !gameState.hasBetThisRound.has(player.id)) {
            const betAmount = Math.min(amount, player.chips);
            player.chips -= betAmount;
            gameState.pot += betAmount;
            gameState.hasBetThisRound.add(player.id);
            gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount: betAmount });
            advanceTurn();
            io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
        }
    });

    socket.on('check', () => {
        const player = gameState.players[gameState.currentPlayerIndex];
        if (player.id === socket.id && !gameState.hasBetThisRound.has(player.id)) {
            gameState.hasBetThisRound.add(player.id);
            gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount: 0 });
            advanceTurn();
            io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
        }
    });

    socket.on('fold', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === gameState.currentPlayerIndex) {
            gameState.players.splice(playerIndex, 1);
            if (gameState.players.length === 0) {
                gameState.gameStage = 'waiting';
                gameState.pot = 0;
            } else {
                gameState.currentPlayerIndex = gameState.currentPlayerIndex % gameState.players.length;
            }
            advanceTurn();
            io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
        }
    });

    socket.on('advance', () => {
        if (gameState.players[gameState.currentPlayerIndex]?.id === socket.id && gameState.hasBetThisRound.size === gameState.players.length) {
            if (gameState.gameStage === 'preflop') {
                gameState.communityCards = [deck.pop(), deck.pop(), deck.pop()];
                gameState.gameStage = 'flop';
            } else if (gameState.gameStage === 'flop') {
                gameState.communityCards.push(deck.pop());
                gameState.gameStage = 'turn';
            } else if (gameState.gameStage === 'turn') {
                gameState.communityCards.push(deck.pop());
                gameState.gameStage = 'river';
            } else if (gameState.gameStage === 'river') {
                gameState.gameStage = 'showdown';
                awardPot();
            } else if (gameState.gameStage === 'showdown') {
                resetGame();
            }
            gameState.hasBetThisRound.clear();
            gameState.dealerIndex = (gameState.dealerIndex + 1) % Math.max(1, gameState.players.length);
            io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
        }
    });

    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        if (gameState.players.length === 0) {
            gameState.gameStage = 'waiting';
            gameState.pot = 0;
        }
        io.emit('update', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
    });
});

function startGame() {
    shuffleDeck();
    gameState.gameStage = 'preflop';
    gameState.players.forEach(player => {
        player.cards = [deck.pop(), deck.pop()];
    });
    gameState.hasBetThisRound.clear();
    gameState.currentHandBets = { preflop: [], flop: [], turn: [], river: [] };
}

function advanceTurn() {
    if (gameState.hasBetThisRound.size === gameState.players.length) return;
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
}

function awardPot() {
    const winner = gameState.players[gameState.currentPlayerIndex];
    winner.chips += gameState.pot;
    gameState.pastHands.push({
        players: gameState.players.map(p => ({ name: p.name, cards: [...p.cards], chips: p.chips })),
        communityCards: [...gameState.communityCards],
        bets: { ...gameState.currentHandBets },
        pot: gameState.pot,
        winner: winner.name
    });
    gameState.pot = 0;
}

function resetGame() {
    gameState.players.forEach(p => p.cards = []);
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.gameStage = 'preflop';
    gameState.hasBetThisRound.clear();
    startGame();
}

server.listen(3000, () => console.log('Server running on http://localhost:3000'));