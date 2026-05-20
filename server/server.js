const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─── Game constants ───────────────────────────────────────────────────────────
const COLORS = ['red', 'yellow', 'green', 'blue'];
const SPECIAL = ['skip', 'reverse', 'draw2'];

function buildDeck() {
  const deck = [];

  for (const color of COLORS) {
    deck.push({ color, value: '0', type: 'number' });

    for (let n = 1; n <= 9; n++) {
      deck.push({ color, value: String(n), type: 'number' });
      deck.push({ color, value: String(n), type: 'number' });
    }

    for (const sp of SPECIAL) {
      deck.push({ color, value: sp, type: 'special' });
      deck.push({ color, value: sp, type: 'special' });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', type: 'wild' });
    deck.push({ color: 'wild', value: 'wild4', type: 'wild' });
  }

  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function cardId() {
  return Math.random().toString(36).slice(2, 9);
}

function stampDeck(deck) {
  return deck.map(c => ({
    ...c,
    id: cardId()
  }));
}

function canPlay(card, topCard, currentColor) {
  if (!topCard) return true;

  if (card.type === 'wild') return true;

  if (card.value === 'wild' || card.value === 'wild4') {
    return true;
  }

  if (card.color === currentColor) {
    return true;
  }

  if (card.value === topCard.value) {
    return true;
  }

  return false;
}

// ─── Room state ──────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomCode, hostId, hostName) {
  const deck = shuffle(stampDeck(buildDeck()));

  const room = {
    code: roomCode,
    hostId,

    players: [
      {
        id: hostId,
        name: hostName,
        hand: [],
        isBot: false,
        unoAlert: false
      }
    ],

    deck,
    discard: [],
    currentTurn: 0,
    direction: 1,
    currentColor: null,
    phase: 'lobby',
    drawStack: 0,
    winner: null,
    lastAction: null
  };

  rooms[roomCode] = room;

  return room;
}

function drawFromDeck(room) {
  if (room.deck.length === 0) {
    const top = room.discard.pop();

    room.deck = shuffle([...room.discard]);

    room.discard = [top];
  }

  return room.deck.pop();
}

function dealCards(room) {
  room.players.forEach(player => {
    player.hand = [];

    for (let i = 0; i < 7; i++) {
      player.hand.push(drawFromDeck(room));
    }
  });

  let startCard;

  do {
    startCard = room.deck.pop();

    if (startCard.type === 'wild') {
      room.deck.unshift(startCard);
    }

  } while (startCard.type === 'wild');

  room.discard.push(startCard);

  room.currentColor = startCard.color;

  if (startCard.value === 'skip') {
    room.currentTurn = 1 % room.players.length;
  }

  if (startCard.value === 'reverse') {
    room.direction = -1;
  }

  if (startCard.value === 'draw2') {
    room.drawStack = 2;
  }
}

function nextTurn(room, skip = false) {
  const count = room.players.length;

  room.currentTurn =
    ((room.currentTurn + room.direction * (skip ? 2 : 1)) % count + count) % count;
}

function roomPublicState(room, forPlayerId) {
  return {
    code: room.code,
    phase: room.phase,
    currentTurn: room.currentTurn,
    direction: room.direction,
    currentColor: room.currentColor,
    drawStack: room.drawStack,
    topCard: room.discard[room.discard.length - 1] || null,
    deckCount: room.deck.length,
    winner: room.winner,
    lastAction: room.lastAction,

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
      handCount: player.hand.length,
      unoAlert: player.unoAlert,
      hand: player.id === forPlayerId ? player.hand : undefined
    }))
  };
}

function broadcastState(room) {
  room.players.forEach(player => {
    if (!player.isBot && io.sockets.sockets.get(player.id)) {
      io.to(player.id).emit(
        'gameState',
        roomPublicState(room, player.id)
      );
    }
  });
}

// ─── Bot logic ───────────────────────────────────────────────────────────────
function botPlay(room) {
  const bot = room.players[room.currentTurn];

  if (!bot || !bot.isBot) return;

  setTimeout(() => {

    if (!rooms[room.code]) return;

    if (rooms[room.code].phase !== 'playing') return;

    const top = room.discard[room.discard.length - 1];

    // Draw stack handling
    if (room.drawStack > 0) {

      const hasCounter = bot.hand.find(card =>
        (top.value === 'draw2' && card.value === 'draw2') ||
        (top.value === 'wild4' && card.value === 'wild4')
      );

      if (hasCounter) {
        playCard(room, bot, hasCounter, null);

      } else {

        const amount = room.drawStack;

        for (let i = 0; i < amount; i++) {
          bot.hand.push(drawFromDeck(room));
        }

        room.drawStack = 0;

        room.lastAction = `${bot.name} pioche ${amount} cartes`;

        nextTurn(room);

        broadcastState(room);

        scheduleBot(room);
      }

      return;
    }

    const playable = bot.hand.filter(card =>
      canPlay(card, top, room.currentColor)
    );

    if (playable.length === 0) {

      bot.hand.push(drawFromDeck(room));

      room.lastAction = `${bot.name} pioche`;

      nextTurn(room);

      broadcastState(room);

      scheduleBot(room);

      return;
    }

    const sorted = [...playable].sort((a, b) => {

      const score = c => {
        if (c.value === 'wild4') return 3;
        if (c.value === 'wild') return 2;
        if (c.type === 'special') return 1;
        return 0;
      };

      return score(b) - score(a);
    });

    const chosen = sorted[0];

    let chosenColor = null;

    if (chosen.type === 'wild') {

      const freq = {};

      bot.hand.forEach(c => {
        if (c.color !== 'wild') {
          freq[c.color] = (freq[c.color] || 0) + 1;
        }
      });

      chosenColor =
        Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0]
        || COLORS[0];
    }

    playCard(room, bot, chosen, chosenColor);

  }, 1200 + Math.random() * 800);
}

function scheduleBot(room) {
  if (room.phase !== 'playing') return;

  const current = room.players[room.currentTurn];

  if (current?.isBot) {
    botPlay(room);
  }
}

function playCard(room, player, card, chosenColor) {

  const idx = player.hand.findIndex(c => c.id === card.id);

  if (idx === -1) return false;

  player.hand.splice(idx, 1);

  room.discard.push(card);

  room.lastAction =
    `${player.name} joue ${card.color !== 'wild' ? card.color + ' ' : ''}${card.value}`;

  if (player.hand.length === 0) {

    room.phase = 'over';

    room.winner = player.name;

    broadcastState(room);

    return true;
  }

  player.unoAlert = player.hand.length === 1;

  if (card.type === 'wild') {
    room.currentColor = chosenColor || COLORS[0];
  } else {
    room.currentColor = card.color;
  }

  if (card.value === 'reverse') {

    room.direction *= -1;

    if (room.players.length === 2) {
      nextTurn(room);
    }

  } else if (card.value === 'skip') {

    nextTurn(room, true);

    broadcastState(room);

    scheduleBot(room);

    return true;

  } else if (card.value === 'draw2') {

    room.drawStack += 2;

  } else if (card.value === 'wild4') {

    room.drawStack += 4;
  }

  nextTurn(room);

  broadcastState(room);

  scheduleBot(room);

  return true;
}

// ─── Socket events ───────────────────────────────────────────────────────────
io.on('connection', socket => {

  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ name, botCount = 0 }) => {

    const code =
      Math.random().toString(36).slice(2, 6).toUpperCase();

    const room =
      createRoom(code, socket.id, name || 'Joueur');

    socket.join(code);

    const botNames = ['🤖 Aria', '🤖 Neo', '🤖 Orion'];

    for (let i = 0; i < Math.min(botCount, 3); i++) {

      room.players.push({
        id: `bot_${i}_${code}`,
        name: botNames[i],
        hand: [],
        isBot: true,
        unoAlert: false
      });
    }

    socket.emit('roomCreated', {
      code,
      state: roomPublicState(room, socket.id)
    });
  });

  socket.on('joinRoom', ({ code, name }) => {

    const room = rooms[code];

    if (!room) {
      return socket.emit('error', 'Salle introuvable');
    }

    if (room.phase !== 'lobby') {
      return socket.emit('error', 'Partie déjà commencée');
    }

    if (room.players.length >= 4) {
      return socket.emit('error', 'Salle pleine');
    }

    room.players.push({
      id: socket.id,
      name: name || 'Joueur',
      hand: [],
      isBot: false,
      unoAlert: false
    });

    socket.join(code);

    socket.emit('roomJoined', {
      code,
      state: roomPublicState(room, socket.id)
    });

    broadcastState(room);
  });

  socket.on('startGame', ({ code }) => {

    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;

    if (room.players.length < 2) {
      return socket.emit('error', 'Il faut au moins 2 joueurs');
    }

    room.phase = 'playing';

    dealCards(room);

    broadcastState(room);

    scheduleBot(room);
  });

  socket.on('playCard', ({ code, cardId, chosenColor }) => {

    const room = rooms[code];

    if (!room || room.phase !== 'playing') return;

    const playerIdx =
      room.players.findIndex(p => p.id === socket.id);

    if (playerIdx !== room.currentTurn) {
      return socket.emit('error', 'Pas ton tour');
    }

    const player = room.players[playerIdx];

    if (room.drawStack > 0) {

      const card =
        player.hand.find(c => c.id === cardId);

      if (!card ||
          (card.value !== 'draw2' && card.value !== 'wild4')) {

        const amount = room.drawStack;

        for (let i = 0; i < amount; i++) {
          player.hand.push(drawFromDeck(room));
        }

        room.lastAction =
          `${player.name} pioche ${amount} cartes`;

        room.drawStack = 0;

        nextTurn(room);

        broadcastState(room);

        scheduleBot(room);

        return;
      }
    }

    const card =
      player.hand.find(c => c.id === cardId);

    if (!card) return;

    const top =
      room.discard[room.discard.length - 1];

    if (!canPlay(card, top, room.currentColor)) {
      return socket.emit('error', 'Carte non jouable');
    }

    playCard(room, player, card, chosenColor);
  });

  socket.on('drawCard', ({ code }) => {

    const room = rooms[code];

    if (!room || room.phase !== 'playing') return;

    const playerIdx =
      room.players.findIndex(p => p.id === socket.id);

    if (playerIdx !== room.currentTurn) return;

    const player = room.players[playerIdx];

    if (room.drawStack > 0) {

      const amount = room.drawStack;

      for (let i = 0; i < amount; i++) {
        player.hand.push(drawFromDeck(room));
      }

      room.lastAction =
        `${player.name} pioche ${amount} cartes`;

      room.drawStack = 0;

    } else {

      player.hand.push(drawFromDeck(room));

      room.lastAction = `${player.name} pioche`;
    }

    nextTurn(room);

    broadcastState(room);

    scheduleBot(room);
  });

  socket.on('restartGame', ({ code }) => {

    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;

    room.deck = shuffle(stampDeck(buildDeck()));

    room.discard = [];

    room.currentTurn = 0;

    room.direction = 1;

    room.drawStack = 0;

    room.winner = null;

    room.lastAction = null;

    room.phase = 'playing';

    dealCards(room);

    broadcastState(room);

    scheduleBot(room);
  });

  socket.on('disconnect', () => {

    for (const [code, room] of Object.entries(rooms)) {

      const idx =
        room.players.findIndex(p => p.id === socket.id);

      if (idx !== -1) {

        room.players.splice(idx, 1);

        if (room.players.filter(p => !p.isBot).length === 0) {

          delete rooms[code];

        } else {

          if (room.currentTurn >= room.players.length) {
            room.currentTurn = 0;
          }

          broadcastState(room);

          scheduleBot(room);
        }

        break;
      }
    }

    console.log('Disconnected:', socket.id);
  });
});

// ─── Health route ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('UNO 3D backend running');
});

// ─── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`);
});