const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
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
    minBuyIn: 10,
    maxBuyIn: 1000,
    deck: [],
    seats: Array(8).fill(null),
    isConfigured: false
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
    console.log('Deck shuffled with', gameState.deck.length, 'cards:', gameState.deck);
}

function dealCards() {
    if (gameState.deck.length < gameState.players.length * 2 + 5) {
        console.log('Deck too small, reshuffling. Current deck:', gameState.deck);
        shuffleDeck();
    }
    gameState.players.forEach(player => {
        const card1 = gameState.deck.pop();
        const card2 = gameState.deck.pop();
        if (!card1 || !card2) {
            console.error('Failed to deal cards to player', player.id, '- Deck:', gameState.deck);
            shuffleDeck();
            player.cards = [gameState.deck.pop() || 'A♥', gameState.deck.pop() || 'K♦'];
        } else {
            player.cards = [card1, card2];
        }
        console.log(`Dealt cards to player ${player.id}:`, player.cards);
    });
    gameState.gameStage = 'preflop';
    console.log('After dealing, deck has', gameState.deck.length, 'cards:', gameState.deck);
}

function advanceStage() {
    gameState.hasBetThisRound.clear();
    switch (gameState.gameStage) {
        case 'preflop':
            gameState.communityCards = [
                gameState.deck.pop() || 'A♠',
                gameState.deck.pop() || 'K♠',
                gameState.deck.pop() || 'Q♠'
            ];
            gameState.gameStage = 'flop';
            break;
        case 'flop':
            gameState.communityCards.push(gameState.deck.pop() || 'J♠');
            gameState.gameStage = 'turn';
            break;
        case 'turn':
            gameState.communityCards.push(gameState.deck.pop() || '10♠');
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
    console.log('Advanced to stage', gameState.gameStage, 'with community cards:', gameState.communityCards);
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

function prepareGameStateForClient() {
    console.log('Sending game state to client:', { ...gameState, hasBetThisRound: Array.from(gameState.hasBetThisRound) });
    return {
        ...gameState,
        hasBetThisRound: Array.from(gameState.hasBetThisRound)
    };
}

io.on('connection', (socket) => {
    console.log(`New connection from ${socket.id} at ${new Date().toISOString()}`);
    gameState.spectators++;
    io.emit('update', prepareGameStateForClient());

    socket.on('configureGame', ({ smallBlind, bigBlind, minBuyIn, maxBuyIn }) => {
        if (!gameState.isConfigured && gameState.players.length === 0) {
            gameState.smallBlind = Math.max(1, smallBlind);
            gameState.bigBlind = Math.max(gameState.smallBlind * 2, bigBlind);
            gameState.minBuyIn = Math.max(gameState.bigBlind, minBuyIn);
            gameState.maxBuyIn = Math.max(gameState.minBuyIn, maxBuyIn);
            gameState.isConfigured = true;
            console.log('Game configured:', { smallBlind: gameState.smallBlind, bigBlind: gameState.bigBlind, minBuyIn: gameState.minBuyIn, maxBuyIn: gameState.maxBuyIn });
            io.emit('update', prepareGameStateForClient());
        } else {
            socket.emit('configError', 'Game already configured or players present');
        }
    });

    socket.on('rejoin', ({ playerId }) => {
        console.log(`Rejoin attempt with playerId: ${playerId}`);
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
            console.log(`Rejoined player ${player.name} at seat ${player.seat}`);
            socket.emit('rejoin', prepareGameStateForClient());
        } else {
            console.log('No matching player found for rejoin');
        }
    });

    socket.on('sitDown', ({ name, chips, seat }) => {
        console.log(`Sit down attempt: ${name} at seat ${seat}, current players: ${gameState.players.length}`);
        if (!gameState.isConfigured) {
            socket.emit('sitDownError', 'Game not configured yet');
            return;
        }
        if (gameState.seats[seat] === null && gameState.players.length < 8 && chips >= gameState.minBuyIn && chips <= gameState.maxBuyIn) {
            const player = { id: socket.id, name, chips, cards: [], seat };
            gameState.seats[seat] = player;
            gameState.players = gameState.seats.filter(p => p !== null);
            gameState.spectators--;
            console.log(`Player ${name} seated at ${seat}, total players: ${gameState.players.length}`);
            if (gameState.players.length >= 2 && gameState.gameStage === 'waiting') {
                console.log('Starting new hand with 2+ players');
                startNewHand();
            } else {
                io.emit('update', prepareGameStateForClient());
            }
        } else {
            console.log(`Seat ${seat} is taken, table full, or invalid buy-in (${chips})`);
            socket.emit('sitDownError', 'Seat taken, table full, or invalid buy-in');
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
            io.emit('update', prepareGameStateForClient());
        }
    });

    socket.on('voiceSignal', (data) => {
        if (data.to) {
            io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
        } else {
            socket.broadcast.emit('voiceSignal', { from: socket.id, signal: data.signal });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`Disconnected: ${socket.id} at ${new Date().toISOString()} - Reason: ${reason}`);
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
        console.error(`Socket error for ${socket.id}: ${error.message} at ${new Date().toISOString()}`);
    });
});

shuffleDeck();
server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on http://localhost:3000');
});