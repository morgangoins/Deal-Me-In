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
    console.log('Deck shuffled:', gameState.deck.length, 'cards');
}

function dealCards() {
    if (gameState.deck.length < gameState.players.length * 2 + 5) shuffleDeck();
    
    gameState.players.forEach(player => {
        if (!player.cards || player.cards.length === 0) {
            player.cards = [gameState.deck.pop(), gameState.deck.pop()].filter(Boolean);
            if (player.cards.length < 2) {
                console.error('Insufficient cards for', player.id);
                shuffleDeck();
                player.cards = [gameState.deck.pop(), gameState.deck.pop()];
            }
            console.log(`Dealt to ${player.id}:`, player.cards);
        }
    });
    gameState.gameStage = 'preflop';
    gameState.currentBet = gameState.bigBlind;
}

function advanceStage() {
    gameState.hasBetThisRound.clear();
    const stages = {
        'preflop': () => {
            gameState.communityCards = Array(3).fill().map(() => gameState.deck.pop() || 'A♠');
            gameState.gameStage = 'flop';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'flop': () => {
            gameState.communityCards.push(gameState.deck.pop() || 'J♠');
            gameState.gameStage = 'turn';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'turn': () => {
            gameState.communityCards.push(gameState.deck.pop() || '10♠');
            gameState.gameStage = 'river';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'river': () => {
            determineWinner();
            gameState.gameStage = 'showdown';
            gameState.currentBet = 0;
            gameState.playerBets = {};
        },
        'showdown': () => {
            setTimeout(startNewHand, 6000);
        }
    };
    
    stages[gameState.gameStage]?.();
    console.log('Stage:', gameState.gameStage, 'Community:', gameState.communityCards);
    broadcastUpdate();
}

function determineWinner() {
    if (gameState.players.length === 0) return;
    const winnerIndex = gameState.players.length === 1 ? 0 : Math.floor(Math.random() * gameState.players.length);
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
    gameState.currentPlayerIndex = (gameState.dealerIndex + 3) % gameState.players.length;
    gameState.currentBet = 0;
    gameState.playerBets = {};
    
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
    gameState.currentBet = Math.max(gameState.currentBet, amount);
    gameState.playerBets[player.id] = (gameState.playerBets[player.id] || 0) + amount;
}

function prepareGameStateForClient() {
    return {
        ...gameState,
        hasBetThisRound: Array.from(gameState.hasBetThisRound),
        deck: undefined
    };
}

function broadcastUpdate() {
    const state = prepareGameStateForClient();
    io.emit('update', state);
    console.log('Broadcast state:', { stage: state.gameStage, players: state.players.length, pot: state.pot, currentBet: state.currentBet });
}

function resetGameState() {
    gameState.players = [];
    gameState.communityCards = [];
    gameState.gameStage = 'waiting';
    gameState.pot = 0;
    gameState.currentPlayerIndex = 0;
    gameState.dealerIndex = 0;
    gameState.hasBetThisRound = new Set();
    gameState.pastHands = [];
    gameState.currentHandBets = { preflop: [], flop: [], turn: [], river: [] };
    gameState.spectators = 0;
    gameState.smallBlind = CONFIG.DEFAULT_SMALL_BLIND;
    gameState.bigBlind = CONFIG.DEFAULT_BIG_BLIND;
    gameState.minBuyIn = CONFIG.DEFAULT_MIN_BUYIN;
    gameState.maxBuyIn = CONFIG.DEFAULT_MAX_BUYIN;
    gameState.deck = [];
    gameState.seats = Array(CONFIG.MAX_PLAYERS).fill(null);
    gameState.isConfigured = false;
    gameState.currentBet = 0;
    gameState.playerBets = {};
    shuffleDeck();
}

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);
    gameState.spectators++;
    broadcastUpdate();

    socket.on('configureGame', ({ smallBlind, bigBlind, minBuyIn, maxBuyIn }) => {
        if (gameState.players.length > 0) {
            return socket.emit('configError', 'Game in progress - cannot reconfigure');
        }
        
        if (gameState.isConfigured) {
            resetGameState();
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
            player.id = socket.id;
            socket.emit('rejoin', prepareGameStateForClient());
        }
    });

    socket.on('sitDown', ({ name, chips, seat }) => {
        console.log(`Sit down attempt: ${name} at seat ${seat}, current players: ${gameState.players.length}`);
        if (!gameState.isConfigured) {
            socket.emit('sitDownError', 'Game not configured yet');
            return;
        }
        if (gameState.seats[seat] !== null) {
            socket.emit('sitDownError', 'Seat already taken');
            return;
        }
        if (gameState.players.length >= CONFIG.MAX_PLAYERS) {
            socket.emit('sitDownError', 'Table is full');
            return;
        }
        if (chips < gameState.minBuyIn || chips > gameState.maxBuyIn) {
            socket.emit('sitDownError', `Invalid buy-in: must be between ${gameState.minBuyIn} and ${gameState.maxBuyIn}`);
            return;
        }
        if (gameState.players.some(p => p.id === socket.id)) {
            socket.emit('sitDownError', 'You are already seated');
            return;
        }

        const player = { id: socket.id, name, chips, cards: [], seat };
        gameState.seats[seat] = player;
        gameState.players = gameState.seats.filter(Boolean);
        gameState.spectators--;

        if (gameState.players.length === 2 && gameState.gameStage === 'waiting') {
            startNewHand();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('bet', (data) => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        const player = gameState.players[playerIndex];
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        const amount = Math.min(data.amount || 0, player.chips);
        if (amount <= 0 || amount > player.chips) return;
        
        player.chips -= amount;
        gameState.pot += amount;
        gameState.hasBetThisRound.add(player.id);
        gameState.currentHandBets[gameState.gameStage].push({ player: player.name, amount });
        gameState.playerBets[player.id] = (gameState.playerBets[player.id] || 0) + amount;
        gameState.currentBet = Math.max(gameState.currentBet, gameState.playerBets[player.id]);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;

        if (gameState.hasBetThisRound.size === gameState.players.length && gameState.players.every(p => p.chips > 0)) {
            advanceStage();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('check', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || gameState.hasBetThisRound.has(player.id)) return;
        
        gameState.hasBetThisRound.add(player.id);
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;

        if (gameState.hasBetThisRound.size === gameState.players.length && gameState.players.every(p => p.chips > 0)) {
            advanceStage();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('fold', () => {
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;
        
        gameState.seats[gameState.players[playerIndex].seat] = null;
        gameState.players.splice(playerIndex, 1);
        gameState.currentPlayerIndex %= gameState.players.length;
        
        if (gameState.players.length === 1) {
            determineWinner();
            advanceStage();
        } else if (gameState.hasBetThisRound.size === gameState.players.length && gameState.players.every(p => p.chips > 0)) {
            advanceStage();
        } else {
            broadcastUpdate();
        }
    });

    socket.on('voiceSignal', ({ to, signal }) => {
        console.log(`Relaying voice signal from ${socket.id} to ${to || 'all'}`);
        const data = { from: socket.id, signal };
        if (to) {
            io.to(to).emit('voiceSignal', data);
        } else {
            socket.broadcast.emit('voiceSignal', data);
        }
    });

    socket.on('chatMessage', ({ name, message }) => {
        io.emit('chatMessage', { name, message });
    });

    socket.on('disconnect', (reason) => {
        console.log(`Disconnected: ${socket.id} - ${reason}`);
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameState.seats[gameState.players[playerIndex].seat] = null;
            gameState.players.splice(playerIndex, 1);
            gameState.currentPlayerIndex %= gameState.players.length;
            
            if (gameState.players.length === 1) {
                determineWinner();
                advanceStage();
            } else if (gameState.hasBetThisRound.size === gameState.players.length && gameState.players.every(p => p.chips > 0)) {
                advanceStage();
            } else {
                broadcastUpdate();
            }
        } else {
            gameState.spectators--;
            broadcastUpdate();
        }
    });

    socket.on('error', (error) => console.error(`Socket error ${socket.id}:`, error));
});

shuffleDeck();
server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on http://localhost:3000');
});