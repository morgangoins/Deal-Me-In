const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const peerServer = PeerServer({ port: 9000, path: '/peerjs' });

app.use(express.static('public'));

const CONFIG = {
    MAX_PLAYERS: 8,
    MIN_CHIPS: 10,
    DEFAULT_SMALL_BLIND: 5,
    DEFAULT_BIG_BLIND: 10,
    DEFAULT_MIN_BUYIN: 10,
    DEFAULT_MAX_BUYIN: 1000
};

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
    smallBlind: CONFIG.DEFAULT_SMALL_BLIND,
    bigBlind: CONFIG.DEFAULT_BIG_BLIND,
    minBuyIn: CONFIG.DEFAULT_MIN_BUYIN,
    maxBuyIn: CONFIG.DEFAULT_MAX_BUYIN,
    deck: [],
    seats: Array(CONFIG.MAX_PLAYERS).fill(null),
    isConfigured: false,
    currentBet: 0,
    playerBets: {}
};

function shuffleDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    gameState.deck = suits.flatMap(suit => ranks.map(rank => rank + suit));
    for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
    }
}

function dealCards() {
    if (gameState.deck.length < gameState.players.length * 2 + 5) shuffleDeck();
    gameState.players.forEach(player => {
        player.cards = [gameState.deck.pop(), gameState.deck.pop()];
    });
    gameState.gameStage = 'preflop';
    gameState.currentBet = gameState.bigBlind;
}

function advanceStage() {
    if (!gameState.players.length) return;
    gameState.hasBetThisRound.clear();
    const stages = {
        'preflop': () => {
            gameState.communityCards = Array(3).fill().map(() => gameState.deck.pop());
            gameState.gameStage = 'flop';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'flop': () => {
            gameState.communityCards.push(gameState.deck.pop());
            gameState.gameStage = 'turn';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'turn': () => {
            gameState.communityCards.push(gameState.deck.pop());
            gameState.gameStage = 'river';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'river': () => {
            determineWinner();
            gameState.gameStage = 'showdown';
            gameState.currentBet = 0;
            gameState.playerBets = {};
            setTimeout(startNewHand, 6000);
        },
        'showdown': () => {
            startNewHand();
        }
    };
    stages[gameState.gameStage]?.();
    broadcastUpdate();
}

function evaluateHand(cards, communityCards) {
    const allCards = [...cards, ...communityCards];
    const ranks = allCards.map(c => c.slice(0, -1)).map(r => '23456789TJQKA'.indexOf(r) + 2);
    const suits = allCards.map(c => c.slice(-1));
    const rankCounts = ranks.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {});
    const suitCounts = suits.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    const sortedRanks = ranks.sort((a, b) => b - a);
    const isFlush = Object.values(suitCounts).some(count => count >= 5);
    const isStraight = sortedRanks.some((r, i) => i <= sortedRanks.length - 5 && r - sortedRanks[i + 4] === 4);

    if (isFlush && isStraight) return "Straight Flush";
    if (Object.values(rankCounts).includes(4)) return "Four of a Kind";
    if (Object.values(rankCounts).includes(3) && Object.values(rankCounts).includes(2)) return "Full House";
    if (isFlush) return "Flush";
    if (isStraight) return "Straight";
    if (Object.values(rankCounts).includes(3)) return "Three of a Kind";
    if (Object.values(rankCounts).filter(c => c === 2).length === 2) return "Two Pair";
    if (Object.values(rankCounts).includes(2)) return "Pair";
    return "High Card";
}

function determineWinner() {
    const activePlayers = gameState.players.filter(p => !p.folded);
    if (activePlayers.length === 0) return;
    const winner = activePlayers.length === 1 ? activePlayers[0] : activePlayers[Math.floor(Math.random() * activePlayers.length)]; // Random for now
    winner.chips += gameState.pot;
    gameState.pastHands.push({
        winner: winner.name,
        pot: gameState.pot,
        communityCards: [...gameState.communityCards],
        bets: { ...gameState.currentHandBets },
        players: gameState.players.map(p => ({
            name: p.name,
            cards: [...p.cards],
            chips: p.chips,
            handType: evaluateHand(p.cards, gameState.communityCards)
        }))
    });
    gameState.pot = 0;
    gameState.currentPlayerIndex = gameState.players.findIndex(p => p.id === winner.id);
}

function startNewHand() {
    if (gameState.players.length < 2) {
        gameState.gameStage = 'waiting';
        broadcastUpdate();
        return;
    }
    gameState.communityCards = [];
    gameState.currentHandBets = { preflop: [], flop: [], turn: [], river: [] };
    gameState.hasBetThisRound.clear();
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    gameState.currentPlayerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    gameState.currentBet = 0;
    gameState.playerBets = {};
    gameState.players.forEach(p => delete p.folded);
    applyBlind((gameState.dealerIndex + 1) % gameState.players.length, gameState.smallBlind);
    applyBlind((gameState.dealerIndex + 2) % gameState.players.length, gameState.bigBlind);
    dealCards();
    broadcastUpdate();
}

function applyBlind(playerIndex, amount) {
    const player = gameState.players[playerIndex];
    if (!player || player.chips < amount) return;
    player.chips -= amount;
    gameState.pot += amount;
    gameState.currentHandBets.preflop.push({ player: player.name, amount });
    gameState.playerBets[player.id] = amount;
    gameState.currentBet = Math.max(gameState.currentBet, amount);
}

function prepareGameStateForClient() {
    return { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound), deck: undefined };
}

function broadcastUpdate() {
    io.emit('update', prepareGameStateForClient());
}

function resetGameState() {
    Object.assign(gameState, {
        players: [], communityCards: [], gameStage: 'waiting', pot: 0, currentPlayerIndex: 0, dealerIndex: 0,
        hasBetThisRound: new Set(), pastHands: [], currentHandBets: { preflop: [], flop: [], turn: [], river: [] },
        spectators: 0, smallBlind: CONFIG.DEFAULT_SMALL_BLIND, bigBlind: CONFIG.DEFAULT_BIG_BLIND,
        minBuyIn: CONFIG.DEFAULT_MIN_BUYIN, maxBuyIn: CONFIG.DEFAULT_MAX_BUYIN, deck: [],
        seats: Array(CONFIG.MAX_PLAYERS).fill(null), isConfigured: false, currentBet: 0, playerBets: {}
    });
    shuffleDeck();
}

let connectedClients = 0;

io.on('connection', (socket) => {
    connectedClients++;
    gameState.spectators = Math.max(0, connectedClients - gameState.players.length);
    broadcastUpdate();

    socket.on('configureGame', ({ smallBlind, bigBlind, minBuyIn, maxBuyIn }) => {
        if (gameState.players.length > 0) return socket.emit('configError', 'Game in progress');
        if (gameState.isConfigured) resetGameState();
        gameState.smallBlind = Math.max(1, smallBlind);
        gameState.bigBlind = Math.max(gameState.smallBlind * 2, bigBlind);
        gameState.minBuyIn = Math.max(gameState.bigBlind, minBuyIn);
        gameState.maxBuyIn = Math.max(gameState.minBuyIn, maxBuyIn);
        gameState.isConfigured = true;
        broadcastUpdate();
    });

    socket.on('rejoin', ({ playerId }) => {
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
            player.id = socket.id;
            socket.emit('rejoin', prepareGameStateForClient());
        }
    });

    socket.on('sitDown', ({ name, chips, seat }) => {
        if (!gameState.isConfigured) return socket.emit('sitDownError', 'Game not configured');
        if (gameState.seats[seat] !== null) return socket.emit('sitDownError', 'Seat taken');
        if (gameState.players.length >= CONFIG.MAX_PLAYERS) return socket.emit('sitDownError', 'Table full');
        if (chips < gameState.minBuyIn || chips > gameState.maxBuyIn) return socket.emit('sitDownError', `Buy-in must be ${gameState.minBuyIn}-${gameState.maxBuyIn}`);
        if (gameState.players.some(p => p.id === socket.id)) return socket.emit('sitDownError', 'Already seated');
        const player = { id: socket.id, name, chips, cards: [], seat };
        gameState.seats[seat] = player;
        gameState.players = gameState.seats.filter(Boolean);
        gameState.spectators = Math.max(0, connectedClients - gameState.players.length);
        if (gameState.players.length === 2 && gameState.gameStage === 'waiting') startNewHand();
        else broadcastUpdate();
    });

    socket.on('bet', ({ amount }) => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1 || gameState.currentPlayerIndex !== playerIndex || gameState.hasBetThisRound.has(socket.id)) return;
        const player = gameState.players[playerIndex];
        amount = Math.min(amount, player.chips);
        const minCall = Math.max(0, gameState.currentBet - (gameState.playerBets[player.id] || 0));
        const minRaise = gameState.currentBet + gameState.bigBlind;
        if (amount < minCall && amount !== player.chips) return;
        const isRaise = amount >= minRaise && gameState.currentBet > 0;
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        gameState.playerBets[player.id] = (gameState.playerBets[player.id] || 0) + amount;
        gameState.currentBet = Math.max(gameState.currentBet, gameState.playerBets[player.id]);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;

        const activePlayers = gameState.players.filter(p => !p.folded);
        if (gameState.hasBetThisRound.size === activePlayers.length && !isRaise) advanceStage();
        else broadcastUpdate();
    });

    socket.on('check', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1 || gameState.currentPlayerIndex !== playerIndex || gameState.hasBetThisRound.has(socket.id)) return;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        if (gameState.hasBetThisRound.size === gameState.players.filter(p => !p.folded).length) advanceStage();
        else broadcastUpdate();
    });

    socket.on('fold', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1 || gameState.currentPlayerIndex !== playerIndex) return;
        gameState.players[playerIndex].folded = true;
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        const activePlayers = gameState.players.filter(p => !p.folded);
        if (activePlayers.length === 1) {
            determineWinner();
            gameState.gameStage = 'showdown';
            broadcastUpdate();
            setTimeout(startNewHand, 6000);
        } else if (gameState.hasBetThisRound.size === activePlayers.length) {
            advanceStage();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('chatMessage', ({ name, message }) => {
        io.emit('chatMessage', { name, message });
    });

    socket.on('voiceSignal', ({ to, signal }) => {
        if (to) io.to(to).emit('voiceSignal', { from: socket.id, signal });
        else socket.broadcast.emit('voiceSignal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
        connectedClients--;
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameState.seats[gameState.players[playerIndex].seat] = null;
            gameState.players.splice(playerIndex, 1);
            gameState.currentPlayerIndex %= gameState.players.length || 1;
            if (gameState.players.length === 1) {
                determineWinner();
                gameState.gameStage = 'showdown';
                broadcastUpdate();
                setTimeout(startNewHand, 6000);
            } else if (gameState.players.length === 0) {
                resetGameState();
                broadcastUpdate();
            } else {
                broadcastUpdate();
            }
        }
        gameState.spectators = Math.max(0, connectedClients - gameState.players.length);
        broadcastUpdate();
    });
});

shuffleDeck();
server.listen(3000, '0.0.0.0', () => console.log('Server running on http://localhost:3000'));