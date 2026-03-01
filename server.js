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

// ── Colour palette assigned to users on join ──────────────────────────────────
const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
  '#ff5722', '#00bcd4', '#8bc34a', '#ff9800',
];
let paletteIndex = 0;

// ── In-memory state ───────────────────────────────────────────────────────────
const users = {};          // socketId → { id, name, color }
let canvasEvents = [];     // append-only log of draw events

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadCanvas() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CANVAS_FILE)) {
      canvasEvents = JSON.parse(fs.readFileSync(CANVAS_FILE, 'utf8'));
      console.log(`Loaded ${canvasEvents.length} canvas events from disk.`);
    }
  } catch (err) {
    console.warn('Could not load canvas state:', err.message);
    canvasEvents = [];
  }
}

function saveCanvas() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(CANVAS_FILE, JSON.stringify(canvasEvents), (err) => {
      if (err) console.warn('Canvas save error:', err.message);
    });
  } catch (err) {
    console.warn('Canvas save error:', err.message);
  }
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

    // Send existing canvas state to the new joiner
    socket.emit('canvas:init', canvasEvents);

    // Send current user list to the new joiner
    socket.emit('user:list', Object.values(users));

    // Announce to everyone else
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
    // Find the last event that belongs to this user
    for (let i = canvasEvents.length - 1; i >= 0; i--) {
      if (canvasEvents[i].userId === socket.id) {
        canvasEvents.splice(i, 1);
        saveCanvas();
        // Tell everyone (including the sender) to re-render from the new state
        io.emit('canvas:undo', canvasEvents);
        break;
      }
    }
  });

  // ── Cursor movement (not stored, ephemeral) ───────────────────────────────
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
    const msg = {
      senderId: socket.id,   // used by client to attach bubble to the right cursor
      name: user.name,
      color: user.color,
      text: trimmedText,
      ts: Date.now(),
    };
    io.emit('chat:message', msg);
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
server.listen(PORT, () => {
  console.log(`Eternal Canvas running at http://localhost:${PORT}`);
});
