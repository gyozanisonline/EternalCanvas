const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

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

// ── Persistence helpers ───────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCanvas() {
  try {
    ensureDataDir();
    if (fs.existsSync(CANVAS_FILE)) {
      canvasEvents = JSON.parse(fs.readFileSync(CANVAS_FILE, 'utf8'));
      console.log(`Loaded ${canvasEvents.length} canvas events from disk.`);
    }
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.nextResetAt && meta.nextResetAt > Date.now()) {
        nextResetAt = meta.nextResetAt;
      } else {
        // Overdue — clear canvas now, start fresh cycle
        canvasEvents = [];
        nextResetAt = Date.now() + RESET_INTERVAL_MS;
        saveCanvas();
      }
    }
  } catch (err) {
    console.warn('Could not load state:', err.message);
    canvasEvents = [];
  }
}

function saveCanvas() {
  try {
    ensureDataDir();
    fs.writeFile(CANVAS_FILE, JSON.stringify(canvasEvents), (err) => {
      if (err) console.warn('Canvas save error:', err.message);
    });
    fs.writeFile(META_FILE, JSON.stringify({ nextResetAt }), (err) => {
      if (err) console.warn('Meta save error:', err.message);
    });
  } catch (err) {
    console.warn('Canvas save error:', err.message);
  }
}

// ── 24-hour reset scheduler ───────────────────────────────────────────────────
function scheduleReset() {
  const delay = Math.max(0, nextResetAt - Date.now());
  console.log(`Next canvas reset in ${Math.round(delay / 1000)}s`);
  setTimeout(() => {
    console.log('Canvas reset — wiping canvas.');
    canvasEvents = [];
    nextResetAt = Date.now() + RESET_INTERVAL_MS;
    saveCanvas();
    io.emit('canvas:reset', { nextResetAt });
    scheduleReset(); // chain for the next cycle
  }, delay);
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('join', ({ name }) => {
    const trimmedName = String(name).trim().slice(0, 32) || 'Anonymous';
    const color = PALETTE[paletteIndex % PALETTE.length];
    paletteIndex++;

    users[socket.id] = { id: socket.id, name: trimmedName, color };
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
    const event = { type: 'stroke', userId: socket.id, ...data };
    canvasEvents.push(event);
    saveCanvas();
    socket.broadcast.emit('draw:stroke', event);
  });

  // ── Draw: placed text ─────────────────────────────────────────────────────
  socket.on('draw:text', (data) => {
    const user = users[socket.id];
    if (!user) return;
    const event = { type: 'text', userId: socket.id, ...data };
    canvasEvents.push(event);
    saveCanvas();
    socket.broadcast.emit('draw:text', event);
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
loadCanvas();
scheduleReset();
server.listen(PORT, () => {
  console.log(`Eternal Canvas running at http://localhost:${PORT}`);
});
