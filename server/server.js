const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const app = express();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const method of ['get', 'post', 'put', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    original(path, ...handlers.map(handler =>
      handler && handler.constructor && handler.constructor.name === 'AsyncFunction'
        ? asyncRoute(handler)
        : handler
    ));
}

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

function env(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUsername(username) {
  return String(username || '').trim().slice(0, 20);
}

function isValidUsername(username) {
  return /^[\p{L}\p{N}_ -]{2,20}$/u.test(username);
}

function publicUser(user, includePrivate = false) {
  if (!user) return null;
  const out = { ...user, _id: user._id.toString() };
  if (!includePrivate) {
    delete out.googleId;
    delete out.email;
  }
  return out;
}

function usernameQuery(username) {
  const clean = normalizeUsername(username);
  return {
    $or: [
      { username: clean },
      { usernameLower: clean.toLowerCase() },
      { username: { $regex: new RegExp('^' + escapeRegex(clean) + '$', 'i') } }
    ]
  };
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
let mongoClient;
const mongoUri = env('MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'mongoDB');
const mongoDbName = env('MONGODB_DB', 'MONGO_DB', 'DB_NAME') || 'unofunk';

async function connectMongo() {
  if (!mongoUri) { console.warn('No MongoDB URI'); return; }
  try {
    mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
    db = mongoClient.db(mongoDbName);
    await db.collection('users').createIndex({ googleId: 1 }, { unique: true });
    await db.collection('users').createIndex({ usernameLower: 1 }, { unique: true, sparse: true });
    await db.collection('messages').createIndex({ from: 1, to: 1, date: 1 });
    console.log(`MongoDB connected (${mongoDbName})`);
  } catch (e) { console.error('MongoDB error:', e.message); }
}
connectMongo();

function getCol(name) { return db ? db.collection(name) : null; }

// ─── Firebase config route (public keys only) ────────────────────────────────
app.get('/api/firebase-config', (req, res) => {
  const config = {
    apiKey: env('FIREBASE_API_KEY', 'apiKey'),
    authDomain: env('FIREBASE_AUTH_DOMAIN', 'authDomain'),
    projectId: env('FIREBASE_PROJECT_ID', 'projectId'),
    storageBucket: env('FIREBASE_STORAGE_BUCKET', 'storageBucket'),
    messagingSenderId: env('FIREBASE_MESSAGING_SENDER_ID', 'messagingSenderId'),
    appId: env('FIREBASE_APP_ID', 'appId'),
    measurementId: env('FIREBASE_MEASUREMENT_ID', 'measurementId')
  };
  const missing = ['apiKey', 'authDomain', 'projectId', 'appId'].filter(key => !config[key]);
  if (missing.length) return res.status(500).json({ error: 'Firebase config missing', missing });
  res.json(config);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mongo: Boolean(db),
    firebase: Boolean(env('FIREBASE_API_KEY', 'apiKey') && env('FIREBASE_PROJECT_ID', 'projectId')),
    rooms: Object.keys(rooms).length
  });
});

// ─── USER ROUTES ─────────────────────────────────────────────────────────────

// Check if username available
app.get('/api/users/check-username/:username', async (req, res) => {
  const col = getCol('users');
  if (!col) return res.json({ available: true });
  const u = normalizeUsername(req.params.username);
  if (!u || u.length < 2 || u.length > 20) return res.json({ available: false, reason: 'Pseudo invalide (2-20 caractères)' });
  const existing = await col.findOne({
    $or: [
      { usernameLower: u.toLowerCase() },
      { username: { $regex: new RegExp('^' + escapeRegex(u) + '$', 'i') } }
    ]
  });
  res.json({ available: !existing });
});

// Register / login with Google
app.post('/api/users/google-auth', async (req, res) => {
  const { googleId, email, displayName, photoURL, username } = req.body;
  if (!googleId || !email) return res.status(400).json({ error: 'Missing fields' });
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });

  let user = await col.findOne({ googleId });

  if (user) {
    // Already registered, return user
    await col.updateOne({ googleId }, { $set: { lastLogin: new Date() } });
    return res.json({ user: publicUser(user, true) });
  }

  // New user — username required
  if (!username) return res.json({ needsUsername: true });
  const cleanUsername = normalizeUsername(username);
  if (!isValidUsername(cleanUsername)) {
    return res.status(400).json({ error: 'Invalid username' });
  }

  // Check username unique
  const usernameLower = cleanUsername.toLowerCase();
  const taken = await col.findOne({
    $or: [
      { usernameLower },
      { username: { $regex: new RegExp('^' + escapeRegex(cleanUsername) + '$', 'i') } }
    ]
  });
  if (taken) return res.json({ usernameTaken: true });

  // Verified user: ClmentCch gets a badge
  const verified = usernameLower === 'clmentcch';

  const newUser = {
    googleId, email, displayName, photoURL,
    username: cleanUsername,
    usernameLower,
    verified,
    createdAt: new Date(),
    lastLogin: new Date(),
    friends: [],
    friendRequests: [],
    followers: [],
    following: [],
    recentGames: []
  };
  const result = await col.insertOne(newUser);
  return res.json({ user: { ...newUser, _id: result.insertedId.toString() } });
});

// Get user profile by username
app.get('/api/users/profile/:username', async (req, res) => {
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const username = normalizeUsername(req.params.username);
  const user = await col.findOne(usernameQuery(username), {
    projection: { googleId: 0, email: 0 }
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

// Get user by googleId (for session restore)
app.get('/api/users/by-google/:googleId', async (req, res) => {
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const user = await col.findOne({ googleId: req.params.googleId });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(user, true));
});

// Save game result
app.post('/api/users/game-result', async (req, res) => {
  const { googleId, result } = req.body;
  // result: { roomCode, players, winner, date, position }
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  await col.updateOne({ googleId }, {
    $push: { recentGames: { $each: [{ ...result, date: new Date() }], $slice: -5, $position: 0 } }
  });
  res.json({ ok: true });
});

// ─── FOLLOW ROUTES ────────────────────────────────────────────────────────────

// Follow a user
app.post('/api/users/follow', async (req, res) => {
  const { googleId, targetUsername } = req.body;
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const me = await col.findOne({ googleId });
  const target = await col.findOne(usernameQuery(targetUsername));
  if (!me || !target) return res.status(404).json({ error: 'User not found' });
  if ((me.following || []).includes(target.username))
    return res.json({ ok: true, already: true });
  await col.updateOne({ googleId }, { $addToSet: { following: target.username } });
  await col.updateOne({ username: target.username }, { $addToSet: { followers: me.username } });
  res.json({ ok: true });
});

// Unfollow
app.post('/api/users/unfollow', async (req, res) => {
  const { googleId, targetUsername } = req.body;
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const me = await col.findOne({ googleId });
  if (!me) return res.status(404).json({ error: 'User not found' });
  const target = await col.findOne(usernameQuery(targetUsername));
  if (!target) return res.status(404).json({ error: 'User not found' });
  await col.updateOne({ googleId }, { $pull: { following: target.username } });
  await col.updateOne({ username: target.username }, { $pull: { followers: me.username } });
  res.json({ ok: true });
});

// ─── FRIEND ROUTES ────────────────────────────────────────────────────────────

// Send friend request
app.post('/api/friends/request', async (req, res) => {
  const { googleId, targetUsername } = req.body;
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const me = await col.findOne({ googleId });
  const target = await col.findOne(usernameQuery(targetUsername));
  if (!me || !target) return res.status(404).json({ error: 'User not found' });
  if ((me.friends || []).includes(target.username)) return res.json({ ok: true, alreadyFriends: true });
  if ((target.friendRequests || []).some(req => req.from === me.username)) return res.json({ ok: true, alreadyRequested: true });
  const reqObj = { from: me.username, fromId: googleId, date: new Date() };
  await col.updateOne({ username: target.username }, { $addToSet: { friendRequests: reqObj } });
  res.json({ ok: true });
});

// Accept friend request
app.post('/api/friends/accept', async (req, res) => {
  const { googleId, fromUsername } = req.body;
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const me = await col.findOne({ googleId });
  if (!me) return res.status(404).json({ error: 'User not found' });
  const fromUser = await col.findOne(usernameQuery(fromUsername));
  if (!fromUser) return res.status(404).json({ error: 'User not found' });
  await col.updateOne({ googleId }, {
    $addToSet: { friends: fromUser.username },
    $pull: { friendRequests: { from: fromUser.username } }
  });
  await col.updateOne({ username: fromUser.username }, { $addToSet: { friends: me.username } });
  res.json({ ok: true });
});

// Decline friend request
app.post('/api/friends/decline', async (req, res) => {
  const { googleId, fromUsername } = req.body;
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  await col.updateOne({ googleId }, { $pull: { friendRequests: { from: fromUsername } } });
  res.json({ ok: true });
});

// Get friends list
app.get('/api/friends/:googleId', async (req, res) => {
  const col = getCol('users');
  if (!col) return res.status(500).json({ error: 'DB unavailable' });
  const me = await col.findOne({ googleId: req.params.googleId });
  if (!me) return res.status(404).json({ error: 'Not found' });
  const friends = me.friends || [];
  const requests = me.friendRequests || [];
  // get friend profiles
  const profiles = friends.length > 0
    ? await col.find({ username: { $in: friends } }, { projection: { googleId: 0, email: 0 } }).toArray()
    : [];
  res.json({ friends: profiles.map(p => publicUser(p)), requests });
});

// ─── MESSAGE ROUTES ───────────────────────────────────────────────────────────

// Send message
app.post('/api/messages/send', async (req, res) => {
  const { googleId, toUsername, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
  const usersCol = getCol('users');
  const msgCol = getCol('messages');
  if (!usersCol || !msgCol) return res.status(500).json({ error: 'DB unavailable' });
  const me = await usersCol.findOne({ googleId });
  if (!me) return res.status(404).json({ error: 'User not found' });
  const target = await usersCol.findOne(usernameQuery(toUsername));
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Check they are friends
  if (!(me.friends || []).includes(target.username)) return res.status(403).json({ error: 'Pas amis' });
  const msg = {
    from: me.username,
    to: target.username,
    content: content.trim().slice(0, 500),
    date: new Date(),
    read: false
  };
  await msgCol.insertOne(msg);
  res.json({ ok: true, message: { ...msg } });
});

// Get conversation
app.get('/api/messages/:googleId/:withUsername', async (req, res) => {
  const usersCol = getCol('users');
  const msgCol = getCol('messages');
  if (!usersCol || !msgCol) return res.status(500).json({ error: 'DB unavailable' });
  const me = await usersCol.findOne({ googleId: req.params.googleId });
  if (!me) return res.status(404).json({ error: 'Not found' });
  const otherUser = await usersCol.findOne(usernameQuery(req.params.withUsername));
  if (!otherUser) return res.status(404).json({ error: 'User not found' });
  const other = otherUser.username;
  const msgs = await msgCol.find({
    $or: [
      { from: me.username, to: other },
      { from: other, to: me.username }
    ]
  }).sort({ date: 1 }).limit(100).toArray();
  // mark as read
  await msgCol.updateMany({ from: other, to: me.username, read: false }, { $set: { read: true } });
  res.json(msgs.map(m => ({ ...m, _id: m._id.toString() })));
});

// Get unread counts per friend
app.get('/api/messages/unread/:googleId', async (req, res) => {
  const usersCol = getCol('users');
  const msgCol = getCol('messages');
  if (!usersCol || !msgCol) return res.status(500).json({ unread: {} });
  const me = await usersCol.findOne({ googleId: req.params.googleId });
  if (!me) return res.status(404).json({ error: 'Not found' });
  const unreadMsgs = await msgCol.find({ to: me.username, read: false }).toArray();
  const counts = {};
  unreadMsgs.forEach(m => { counts[m.from] = (counts[m.from] || 0) + 1; });
  res.json({ unread: counts });
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

function cardId() { return Math.random().toString(36).slice(2, 9); }
function stampDeck(deck) { return deck.map(c => ({ ...c, id: cardId() })); }

function canPlay(card, topCard, currentColor) {
  if (!topCard) return true;
  if (card.type === 'wild') return true;
  if (card.value === 'wild' || card.value === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

const rooms = {};

function createRoom(roomCode, hostId, hostName) {
  const deck = shuffle(stampDeck(buildDeck()));
  const room = {
    code: roomCode, hostId,
    players: [{ id: hostId, name: hostName, hand: [], isBot: false, unoAlert: false }],
    deck, discard: [], currentTurn: 0, direction: 1,
    currentColor: null, phase: 'lobby', drawStack: 0,
    winner: null, lastAction: null
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
    for (let i = 0; i < 7; i++) player.hand.push(drawFromDeck(room));
  });
  let startCard;
  do {
    startCard = room.deck.pop();
    if (startCard.type === 'wild') room.deck.unshift(startCard);
  } while (startCard.type === 'wild');
  room.discard.push(startCard);
  room.currentColor = startCard.color;
  if (startCard.value === 'skip') room.currentTurn = 1 % room.players.length;
  if (startCard.value === 'reverse') room.direction = -1;
  if (startCard.value === 'draw2') room.drawStack = 2;
}

function nextTurn(room, skip = false) {
  const count = room.players.length;
  room.currentTurn = ((room.currentTurn + room.direction * (skip ? 2 : 1)) % count + count) % count;
}

function roomPublicState(room, forPlayerId) {
  return {
    code: room.code, phase: room.phase, currentTurn: room.currentTurn,
    direction: room.direction, currentColor: room.currentColor,
    drawStack: room.drawStack, topCard: room.discard[room.discard.length - 1] || null,
    deckCount: room.deck.length, winner: room.winner, lastAction: room.lastAction,
    players: room.players.map(player => ({
      id: player.id, name: player.name, isBot: player.isBot,
      handCount: player.hand.length, unoAlert: player.unoAlert,
      hand: player.id === forPlayerId ? player.hand : undefined
    }))
  };
}

function broadcastState(room) {
  room.players.forEach(player => {
    if (!player.isBot && io.sockets.sockets.get(player.id)) {
      io.to(player.id).emit('gameState', roomPublicState(room, player.id));
    }
  });
}

function botPlay(room) {
  const bot = room.players[room.currentTurn];
  if (!bot || !bot.isBot) return;
  setTimeout(() => {
    if (!rooms[room.code] || rooms[room.code].phase !== 'playing') return;
    const top = room.discard[room.discard.length - 1];
    if (room.drawStack > 0) {
      const hasCounter = bot.hand.find(card =>
        (top.value === 'draw2' && card.value === 'draw2') ||
        (top.value === 'wild4' && card.value === 'wild4')
      );
      if (hasCounter) { playCard(room, bot, hasCounter, null); }
      else {
        const amount = room.drawStack;
        for (let i = 0; i < amount; i++) bot.hand.push(drawFromDeck(room));
        room.drawStack = 0;
        room.lastAction = `${bot.name} pioche ${amount} cartes`;
        nextTurn(room); broadcastState(room); scheduleBot(room);
      }
      return;
    }
    const playable = bot.hand.filter(card => canPlay(card, top, room.currentColor));
    if (playable.length === 0) {
      bot.hand.push(drawFromDeck(room));
      room.lastAction = `${bot.name} pioche`;
      nextTurn(room); broadcastState(room); scheduleBot(room);
      return;
    }
    const sorted = [...playable].sort((a, b) => {
      const score = c => c.value === 'wild4' ? 3 : c.value === 'wild' ? 2 : c.type === 'special' ? 1 : 0;
      return score(b) - score(a);
    });
    const chosen = sorted[0];
    let chosenColor = null;
    if (chosen.type === 'wild') {
      const freq = {};
      bot.hand.forEach(c => { if (c.color !== 'wild') freq[c.color] = (freq[c.color] || 0) + 1; });
      chosenColor = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || COLORS[0];
    }
    playCard(room, bot, chosen, chosenColor);
  }, 1200 + Math.random() * 800);
}

function scheduleBot(room) {
  if (room.phase !== 'playing') return;
  const current = room.players[room.currentTurn];
  if (current?.isBot) botPlay(room);
}

function playCard(room, player, card, chosenColor) {
  const idx = player.hand.findIndex(c => c.id === card.id);
  if (idx === -1) return false;
  player.hand.splice(idx, 1);
  room.discard.push(card);
  room.lastAction = `${player.name} joue ${card.color !== 'wild' ? card.color + ' ' : ''}${card.value}`;
  if (player.hand.length === 0) {
    room.phase = 'over'; room.winner = player.name;
    broadcastState(room); return true;
  }
  player.unoAlert = player.hand.length === 1;
  if (card.type === 'wild') room.currentColor = chosenColor || COLORS[0];
  else room.currentColor = card.color;
  if (card.value === 'reverse') {
    room.direction *= -1;
    if (room.players.length === 2) nextTurn(room);
  } else if (card.value === 'skip') {
    nextTurn(room, true); broadcastState(room); scheduleBot(room); return true;
  } else if (card.value === 'draw2') {
    room.drawStack += 2;
  } else if (card.value === 'wild4') {
    room.drawStack += 4;
  }
  nextTurn(room); broadcastState(room); scheduleBot(room);
  return true;
}

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ name, botCount = 0 }) => {
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    const room = createRoom(code, socket.id, name || 'Joueur');
    socket.join(code);
    const botNames = ['🤖 Aria', '🤖 Neo', '🤖 Orion'];
    for (let i = 0; i < Math.min(botCount, 3); i++) {
      room.players.push({ id: `bot_${i}_${code}`, name: botNames[i], hand: [], isBot: true, unoAlert: false });
    }
    socket.emit('roomCreated', { code, state: roomPublicState(room, socket.id) });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Salle introuvable');
    if (room.phase !== 'lobby') return socket.emit('error', 'Partie déjà commencée');
    if (room.players.length >= 4) return socket.emit('error', 'Salle pleine');
    room.players.push({ id: socket.id, name: name || 'Joueur', hand: [], isBot: false, unoAlert: false });
    socket.join(code);
    socket.emit('roomJoined', { code, state: roomPublicState(room, socket.id) });
    broadcastState(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', 'Il faut au moins 2 joueurs');
    room.phase = 'playing';
    dealCards(room);
    broadcastState(room);
    scheduleBot(room);
  });

  socket.on('playCard', ({ code, cardId, chosenColor }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.currentTurn) return socket.emit('error', 'Pas ton tour');
    const player = room.players[playerIdx];
    if (room.drawStack > 0) {
      const card = player.hand.find(c => c.id === cardId);
      if (!card || (card.value !== 'draw2' && card.value !== 'wild4')) {
        const amount = room.drawStack;
        for (let i = 0; i < amount; i++) player.hand.push(drawFromDeck(room));
        room.lastAction = `${player.name} pioche ${amount} cartes`;
        room.drawStack = 0;
        nextTurn(room); broadcastState(room); scheduleBot(room);
        return;
      }
    }
    const card = player.hand.find(c => c.id === cardId);
    if (!card) return;
    const top = room.discard[room.discard.length - 1];
    if (!canPlay(card, top, room.currentColor)) return socket.emit('error', 'Carte non jouable');
    playCard(room, player, card, chosenColor);
  });

  socket.on('drawCard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.currentTurn) return;
    const player = room.players[playerIdx];
    if (room.drawStack > 0) {
      const amount = room.drawStack;
      for (let i = 0; i < amount; i++) player.hand.push(drawFromDeck(room));
      room.lastAction = `${player.name} pioche ${amount} cartes`;
      room.drawStack = 0;
    } else {
      player.hand.push(drawFromDeck(room));
      room.lastAction = `${player.name} pioche`;
    }
    nextTurn(room); broadcastState(room); scheduleBot(room);
  });

  socket.on('restartGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    room.deck = shuffle(stampDeck(buildDeck()));
    room.discard = []; room.currentTurn = 0; room.direction = 1;
    room.drawStack = 0; room.winner = null; room.lastAction = null;
    room.phase = 'playing';
    dealCards(room); broadcastState(room); scheduleBot(room);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.filter(p => !p.isBot).length === 0) { delete rooms[code]; }
        else {
          if (room.currentTurn >= room.players.length) room.currentTurn = 0;
          broadcastState(room); scheduleBot(room);
        }
        break;
      }
    }
    console.log('Disconnected:', socket.id);
  });
});

app.get('/', (req, res) => res.json({ ok: true, service: 'UNO 3D backend' }));

app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO server running on port ${PORT}`));

process.on('SIGTERM', async () => {
  server.close(async () => {
    if (mongoClient) await mongoClient.close();
    process.exit(0);
  });
});
