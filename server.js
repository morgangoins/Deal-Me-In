const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

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
    isConfigured: false
};

function shuffleDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    gameState.deck = suits.flatMap(suit => ranks.map(rank => rank + suit));
    for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
    }
    console.log('Deck shuffled:', gameState.deck.length, 'cards');
}

function dealCards() {
    if (gameState.deck.length < gameState.players.length * 2 + 5) shuffleDeck();
    
    gameState.players.forEach(player => {
        player.cards = [gameState.deck.pop(), gameState.deck.pop()].filter(Boolean);
        if (player.cards.length < 2) {
            console.error('Insufficient cards for', player.id);
            shuffleDeck();
            player.cards = [gameState.deck.pop(), gameState.deck.pop()];
        }
        console.log(`Dealt to ${player.id}:`, player.cards);
    });
    gameState.gameStage = 'preflop';
}

function advanceStage() {
    gameState.hasBetThisRound.clear();
    const stages = {
        'preflop': () => {
            gameState.communityCards = Array(3).fill().map(() => gameState.deck.pop() || 'A♠');
            gameState.gameStage = 'flop';
        },
        'flop': () => {
            gameState.communityCards.push(gameState.deck.pop() || 'J♠');
            gameState.gameStage = 'turn';
        },
        'turn': () => {
            gameState.communityCards.push(gameState.deck.pop() || '10♠');
            gameState.gameStage = 'river';
        },
        'river': () => {
            determineWinner();
            gameState.gameStage = 'showdown';
        },
        'showdown': startNewHand
    };
    
    stages[gameState.gameStage]?.();
    console.log('Stage:', gameState.gameStage, 'Community:', gameState.communityCards);
}

function determineWinner() {
    if (gameState.players.length === 0) return;
    const winnerIndex = Math.floor(Math.random() * gameState.players.length);
    const winner = gameState.players[winnerIndex];
    winner.chips += gameState.pot;
    
    gameState.pastHands.push({
        winner: winner.name,
        pot: gameState.pot,
        communityCards: [...gameState.communityCards],
        bets: { ...gameState.currentHandBets },
        players: gameState.players.map(p => ({ name: p.name, cards: [...p.cards], chips: p.chips }))
    });
    
    gameState.pot = 0;
    gameState.currentPlayerIndex = winnerIndex;
}

function startNewHand() {
    if (gameState.players.length < 2) {
        gameState.gameStage = 'waiting';
        return;
    }
    
    gameState.communityCards = [];
    gameState.currentHandBets = { preflop: [], flop: [], turn: [], river: [] };
    gameState.hasBetThisRound.clear();
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    gameState.currentPlayerIndex = (gameState.dealerIndex + 3) % gameState.players.length; // Start after big blind
    
    const smallBlindIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    const bigBlindIndex = (gameState.dealerIndex + 2) % gameState.players.length;
    
    applyBlind(smallBlindIndex, gameState.smallBlind);
    applyBlind(bigBlindIndex, gameState.bigBlind);
    
    dealCards();
    broadcastUpdate();
}

function applyBlind(playerIndex, amount) {
    const player = gameState.players[playerIndex];
    if (!player || player.chips < amount) return;
    
    player.chips -= amount;
    gameState.pot += amount;
    gameState.currentHandBets.preflop.push({ player: player.name, amount });
    gameState.hasBetThisRound.add(player.id);
}

function prepareGameStateForClient() {
    return {
        ...gameState,
        hasBetThisRound: Array.from(gameState.hasBetThisRound),
        deck: undefined // Don't send full deck to clients
    };
}

function broadcastUpdate() {
    const state = prepareGameStateForClient();
    io.emit('update', state);
    console.log('Broadcast state:', { stage: state.gameStage, players: state.players.length, pot: state.pot });
}

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);
    gameState.spectators++;
    broadcastUpdate();

    socket.on('configureGame', ({ smallBlind, bigBlind, minBuyIn, maxBuyIn }) => {
        if (gameState.isConfigured || gameState.players.length > 0) {
            return socket.emit('configError', 'Game already configured or in progress');
        }
        
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
            player.id = socket.id; // Update socket ID
            socket.emit('rejoin', prepareGameStateForClient());
        }
    });

    socket.on('sitDown', ({ name, chips, seat }) => {
        if (!gameState.isConfigured || 
            gameState.seats[seat] !== null || 
            gameState.players.length >= CONFIG.MAX_PLAYERS || 
            chips < gameState.minBuyIn || 
            chips > gameState.maxBuyIn) {
            return socket.emit('sitDownError', 'Invalid sit-down conditions');
        }
        
        const player = { id: socket.id, name, chips, cards: [], seat };
        gameState.seats[seat] = player;
        gameState.players = gameState.seats.filter(Boolean);
        gameState.spectators--;
        
        if (gameState.players.length >= 2 && gameState.gameStage === 'waiting') {
            startNewHand();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('bet', (data) => {
        const playerIndex = data.playerIndex ?? gameState.players.findIndex(p => p.id === socket.id);
        const player = gameState.players[playerIndex];
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        const amount = data.auto 
            ? (playerIndex === (gameState.dealerIndex + 1) % gameState.players.length 
                ? gameState.smallBlind 
                : gameState.bigBlind)
            : Math.min(data.amount, player.chips);
            
        if (amount <= 0 || amount > player.chips) return;
        
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        broadcastUpdate();
    });

    socket.on('check', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        gameState.hasBetThisRound.add(player.id);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        broadcastUpdate();
    });

    socket.on('fold', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;
        
        gameState.seats[gameState.players[playerIndex].seat] = null;
        gameState.players.splice(playerIndex, 1);
        gameState.currentPlayerIndex %= gameState.players.length;
        
        if (gameState.players.length === 1) {
            determineWinner();
            gameState.gameStage = 'showdown';
        }
        broadcastUpdate();
    });

    socket.on('advance', () => {
        if (gameState.hasBetThisRound.size === gameState.players.length) {
            advanceStage();
            broadcastUpdate();
        }
    });

    socket.on('voiceSignal', ({ to, signal }) => {
        const data = { from: socket.id, signal };
        to ? io.to(to).emit('voiceSignal', data) : socket.broadcast.emit('voiceSignal', data);
    });

    socket.on('disconnect', (reason) => {
        console.log(`Disconnected: ${socket.id} - ${reason}`);
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameState.seats[gameState.players[playerIndex].seat] = null;
            gameState.players.splice(playerIndex, 1);
            gameState.currentPlayerIndex %= gameState.players.length;
        } else {
            gameState.spectators--;
        }
        broadcastUpdate();
    });

    socket.on('error', (error) => console.error(`Socket error ${socket.id}:`, error));
});

shuffleDeck();
server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on http://localhost:3000');
});