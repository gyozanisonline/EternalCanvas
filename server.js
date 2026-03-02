require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
});

const PORT = process.env.PORT || 3001;
const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Colour palette assigned to users on join ──────────────────────────────────
const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
  '#ff5722', '#00bcd4', '#8bc34a', '#ff9800',
];
let paletteIndex = 0;

// ── In-memory state ───────────────────────────────────────────────────────────
const users = {};
let canvasEvents = [];
let nextResetAt = Date.now() + RESET_INTERVAL_MS;

// ── MongoDB persistence ───────────────────────────────────────────────────────
let db = null;

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.log('No MONGODB_URI set — canvas state will not persist across restarts.');
    return;
  }
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('eternalcanvas');
    console.log('Connected to MongoDB.');
  } catch (err) {
    console.warn('MongoDB connection failed:', err.message);
  }
}

async function loadCanvas() {
  if (!db) return;
  try {
    const doc = await db.collection('state').findOne({ _id: 'canvas' });
    if (doc) {
      canvasEvents = doc.events || [];
      if (doc.nextResetAt && doc.nextResetAt > Date.now()) {
        nextResetAt = doc.nextResetAt;
      } else if (doc.nextResetAt) {
        // Overdue reset — archive then clear
        await saveArchive('reset');
        canvasEvents = [];
        nextResetAt = Date.now() + RESET_INTERVAL_MS;
        saveCanvas();
      }
      console.log(`Loaded ${canvasEvents.length} canvas events from MongoDB.`);
    }
  } catch (err) {
    console.warn('Could not load canvas:', err.message);
  }
}

function saveCanvas() {
  if (!db) return;
  db.collection('state').updateOne(
    { _id: 'canvas' },
    { $set: { events: canvasEvents, nextResetAt } },
    { upsert: true }
  ).catch(err => console.warn('Canvas save error:', err.message));
}

// ── Archive persistence ───────────────────────────────────────────────────────
function computeStats(events) {
  const byUser = {};
  let totalStrokes = 0, totalTexts = 0, totalPoints = 0;
  for (const ev of events) {
    if (ev.type === 'stroke') {
      totalStrokes++;
      totalPoints += (ev.points || []).length;
      if (ev.userName) {
        if (!byUser[ev.userName]) byUser[ev.userName] = { count: 0, color: ev.userColor || '#888' };
        byUser[ev.userName].count++;
        if (ev.userColor) byUser[ev.userName].color = ev.userColor;
      }
    }
    if (ev.type === 'text') totalTexts++;
  }
  const topArtists = Object.entries(byUser)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, { count, color }]) => ({ name, count, color }));
  return { totalStrokes, totalTexts, totalPoints, topArtists };
}

async function saveArchive(reason = 'reset') {
  if (!db || canvasEvents.length === 0) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    await db.collection('archives').insertOne({
      date,
      savedAt: Date.now(),
      reason,
      events: canvasEvents,
      stats: computeStats(canvasEvents),
    });
    console.log(`Archive saved for ${date} (${canvasEvents.length} events, reason: ${reason}).`);
  } catch (err) {
    console.warn('Archive save error:', err.message);
  }
}

// ── 24-hour reset scheduler ───────────────────────────────────────────────────
function scheduleReset() {
  const delay = Math.max(0, nextResetAt - Date.now());
  console.log(`Next canvas reset in ${Math.round(delay / 1000)}s`);
  setTimeout(async () => {
    console.log('Canvas reset — saving archive then wiping canvas.');
    await saveArchive('reset');
    canvasEvents = [];
    nextResetAt = Date.now() + RESET_INTERVAL_MS;
    saveCanvas();
    io.emit('canvas:reset', { nextResetAt });
    scheduleReset(); // chain for the next cycle
  }, delay);
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Serve archive page at /archive (without .html extension)
app.get('/archive', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// ── Archive REST API ──────────────────────────────────────────────────────────
app.get('/api/archives', async (_req, res) => {
  if (!db) return res.json([]);
  try {
    const archives = await db.collection('archives')
      .find({}, { projection: { events: 0 } }) // omit events for the list
      .sort({ savedAt: -1 })
      .limit(100)
      .toArray();
    res.json(archives);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/archives/:id', async (req, res) => {
  if (!db) return res.status(404).json({ error: 'No database' });
  try {
    const doc = await db.collection('archives').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('user:join', ({ name }) => {
    const trimmedName = String(name).trim().slice(0, 32) || 'Anonymous';
    const color = PALETTE[paletteIndex % PALETTE.length];
    paletteIndex++;

    users[socket.id] = { id: socket.id, name: trimmedName, color, tokens: 0 };
    console.log(`User joined: ${trimmedName} (${socket.id})`);

    // Send existing canvas state + reset time to the new joiner
    socket.emit('canvas:init', { events: canvasEvents, nextResetAt });
    socket.emit('user:list', Object.values(users));
    socket.broadcast.emit('user:joined', users[socket.id]);
    io.emit('user:list', Object.values(users));
  });

  // ── Draw: freehand stroke ─────────────────────────────────────────────────
  socket.on('draw:stroke', (data) => {
    const user = users[socket.id];
    if (!user) return;
    const event = { type: 'stroke', userId: socket.id, userName: user.name, userColor: user.color, ...data };
    canvasEvents.push(event);
    saveCanvas();
    socket.broadcast.emit('draw:stroke', event);
  });

  // ── Draw: placed text ─────────────────────────────────────────────────────
  socket.on('draw:text', (data) => {
    const user = users[socket.id];
    if (!user) return;
    const event = { type: 'text', userId: socket.id, userName: user.name, userColor: user.color, ...data };
    canvasEvents.push(event);
    saveCanvas();
    socket.broadcast.emit('draw:text', event);
  });

  // ── 1UP reaction ──────────────────────────────────────────────────────────
  socket.on('draw:oneup', ({ x, y }) => {
    const user = users[socket.id];
    if (!user) return;
    io.emit('draw:oneup', { name: user.name, color: user.color, x, y });
  });

  // ── Archive 1UP (no user:join required) ───────────────────────────────────
  socket.on('archive:oneup', ({ x, y, name, color }) => {
    const safeName = String(name || '✦').slice(0, 32);
    const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#c8785a';
    io.emit('draw:oneup', { name: safeName, color: safeColor, x, y });
  });

  // ── Token balance update ───────────────────────────────────────────────────
  socket.on('user:tokens', ({ tokens }) => {
    const user = users[socket.id];
    if (!user) return;
    user.tokens = Math.max(0, Math.floor(tokens));
    io.emit('user:list', Object.values(users));
  });

  // ── Draw: live segment while someone is still drawing ────────────────────
  socket.on('draw:segment', (data) => {
    socket.broadcast.emit('draw:segment', { ...data, userId: socket.id });
  });

  // ── Undo: remove this user's last draw event ──────────────────────────────
  socket.on('undo', () => {
    const user = users[socket.id];
    if (!user) return;
    for (let i = canvasEvents.length - 1; i >= 0; i--) {
      if (canvasEvents[i].userId === socket.id) {
        canvasEvents.splice(i, 1);
        saveCanvas();
        io.emit('canvas:undo', canvasEvents);
        break;
      }
    }
  });

  // ── Cursor movement ───────────────────────────────────────────────────────
  socket.on('cursor:move', ({ x, y }) => {
    const user = users[socket.id];
    if (!user) return;
    socket.broadcast.emit('cursor:update', { id: socket.id, name: user.name, color: user.color, x, y });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  socket.on('admin:force_clear', async () => {
    console.log(`Canvas force cleared by admin socket: ${socket.id}`);
    await saveArchive('force_clear');
    canvasEvents = [];
    nextResetAt = Date.now() + RESET_INTERVAL_MS;
    saveCanvas();
    io.emit('canvas:reset', { nextResetAt });
  });

  // ── Chat message ──────────────────────────────────────────────────────────
  socket.on('chat:message', ({ text }) => {
    const user = users[socket.id];
    if (!user) return;
    const trimmedText = String(text).trim().slice(0, 500);
    if (!trimmedText) return;
    io.emit('chat:message', {
      senderId: socket.id,
      name: user.name,
      color: user.color,
      text: trimmedText,
      ts: Date.now(),
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      console.log(`User left: ${user.name} (${socket.id})`);
      delete users[socket.id];
      socket.broadcast.emit('cursor:remove', socket.id);
      io.emit('user:list', Object.values(users));
    }
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log(`Node.js ${process.version}`);
connectDB().then(() => {
  loadCanvas().then(() => {
    scheduleReset();
    server.listen(PORT, () => {
      console.log(`Eternal Canvas running at http://localhost:${PORT}`);
    });
  });
});
