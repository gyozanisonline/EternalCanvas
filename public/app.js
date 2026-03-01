/* ── Eternal Canvas — client ─────────────────────────────────────────────── */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const ambCanvas = document.getElementById('ambient-canvas');

const appEl = document.getElementById('app');
const canvas = document.getElementById('canvas');
const cursorCanvas = document.getElementById('cursors');
const minimapEl = document.getElementById('minimap');
const canvasWrap = document.getElementById('canvas-wrap');
const coordsEl = document.getElementById('coords');
const zoomLabelEl = document.getElementById('zoom-label');
const zoomHintEl = document.getElementById('zoom-hint');

const toolBrush = document.getElementById('tool-brush');
const toolText = document.getElementById('tool-text');
const colorPicker = document.getElementById('color-picker');
const sizeSlider = document.getElementById('size-slider');
const sizeLabel = document.getElementById('size-label');
const userDot = document.getElementById('user-dot');
const userNameDisp = document.getElementById('user-name-display');
const colorSwatch = document.getElementById('color-swatch');

const userListEl = document.getElementById('user-list');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

const devPanel = document.getElementById('dev-panel');
const devCloseBtn = document.getElementById('dev-close');
const devClearBtn = document.getElementById('dev-clear-btn');
const devBgColor = document.getElementById('dev-bg-color');
const devStrokeColor = document.getElementById('dev-stroke-color');

// ── Contexts ──────────────────────────────────────────────────────────────────
const ctx = canvas.getContext('2d');
const curCtx = cursorCanvas.getContext('2d');
const mmCtx = minimapEl.getContext('2d');
const ambCtx = ambCanvas ? ambCanvas.getContext('2d') : null;

// ── World constants ───────────────────────────────────────────────────────────
const WORLD_W = 4000;
const WORLD_H = 3000;
const MM_W = 160;
const MM_H = Math.round(MM_W * WORLD_H / WORLD_W); // 120
const MIN_DRAW_ZOOM = 0.5; // must be at least 50% zoom to draw

minimapEl.width = MM_W;
minimapEl.height = MM_H;

// ── Vector storage ────────────────────────────────────────────────────────────
// No raster offscreen canvas. All strokes are paths, re-drawn every frame.
const events = []; // { type, ...fields } — completed strokes & texts
const remoteInProgress = {}; // userId → { points[], color, size } — live remote strokes

// Minimap uses a separate offscreen canvas rebuilt only when strokes are added
const mmWorld = document.createElement('canvas');
mmWorld.width = MM_W;
mmWorld.height = MM_H;
const mmWCtx = mmWorld.getContext('2d');

// ── Viewport ──────────────────────────────────────────────────────────────────
let panX = 0, panY = 0, zoom = 1;

function screenToWorld(sx, sy) { return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }; }
function worldToScreen(wx, wy) { return { x: wx * zoom + panX, y: wy * zoom + panY }; }
function clampZoom(z) { return Math.max(0.04, Math.min(14, z)); }

function initViewport() {
  const pad = 48;
  zoom = Math.min((canvas.width - pad * 2) / WORLD_W, (canvas.height - pad * 2) / WORLD_H);
  panX = (canvas.width - WORLD_W * zoom) / 2;
  panY = (canvas.height - WORLD_H * zoom) / 2;
}

// ── Shared draw primitives (work on any context in world-space) ───────────────
function renderStroke(c, { points, color, size }) {
  if (!points || points.length < 2) return;
  c.beginPath();
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
  c.stroke();
}

function renderText(c, { x, y, text, color, fontSize }) {
  c.fillStyle = color;
  c.font = `${fontSize}px 'Courier Prime', 'Courier New', monospace`;
  c.fillText(text, x, y);
}

// ── Minimap ───────────────────────────────────────────────────────────────────
function rebuildMinimap() {
  const s = MM_W / WORLD_W;
  mmWCtx.fillStyle = '#FAFAF7';
  mmWCtx.fillRect(0, 0, MM_W, MM_H);
  mmWCtx.save();
  mmWCtx.scale(s, s);
  for (const ev of events) {
    if (ev.type === 'stroke') renderStroke(mmWCtx, ev);
    if (ev.type === 'text') renderText(mmWCtx, ev);
  }
  mmWCtx.restore();
}

function updateMinimap() {
  mmCtx.drawImage(mmWorld, 0, 0);

  // Remote cursor dots on minimap
  const s = MM_W / WORLD_W;
  for (const { color, wx, wy } of Object.values(remoteCursors)) {
    mmCtx.beginPath();
    mmCtx.arc(wx * s, wy * s, 2, 0, Math.PI * 2);
    mmCtx.fillStyle = color;
    mmCtx.fill();
  }

  // Viewport indicator
  const vx = Math.max(0, (-panX / zoom) * s);
  const vy = Math.max(0, (-panY / zoom) * s);
  const vw = Math.min(MM_W - vx, (canvas.width / zoom) * s);
  const vh = Math.min(MM_H - vy, (canvas.height / zoom) * s);
  mmCtx.fillStyle = 'rgba(200,119,87,.1)';
  mmCtx.fillRect(vx, vy, vw, vh);
  mmCtx.strokeStyle = '#c87757';
  mmCtx.lineWidth = 1.5;
  mmCtx.strokeRect(vx, vy, vw, vh);
}

minimapEl.addEventListener('click', (e) => {
  const r = minimapEl.getBoundingClientRect();
  const wx = ((e.clientX - r.left) / MM_W) * WORLD_W;
  const wy = ((e.clientY - r.top) / MM_H) * WORLD_H;
  panX = canvas.width / 2 - wx * zoom;
  panY = canvas.height / 2 - wy * zoom;
  scheduleRender();
});

// ── Render pipeline ───────────────────────────────────────────────────────────
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(renderViewport);
}

function renderViewport() {
  renderScheduled = false;

  // Background behind canvas
  ctx.fillStyle = devBgColor.value;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Dot grid
  drawDotGrid();

  // World-space transform
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // The canvas — warm paper white
  ctx.fillStyle = '#FAFAF7';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // All completed events
  for (const ev of events) {
    if (ev.type === 'stroke') renderStroke(ctx, ev);
    if (ev.type === 'text') renderText(ctx, ev);
  }

  // Live strokes from remote users (visible as they draw)
  for (const stroke of Object.values(remoteInProgress)) {
    renderStroke(ctx, stroke);
  }

  // My own live stroke
  if (drawing && currentStrokePoints.length >= 2) {
    renderStroke(ctx, {
      points: currentStrokePoints,
      color: colorPicker.value,
      size: 1,
    });
  }

  // Subtle world border
  ctx.strokeStyle = devStrokeColor.value;
  ctx.lineWidth = 3 / zoom;
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

  ctx.restore();

  // Grid overlay (appears when sufficiently zoomed in)
  drawGrid();

  // Overlays
  redrawCursors();
  updateMinimap();
  updateHUD();
}

// ── Dot grid background ───────────────────────────────────────────────────────
// Screen-space grid that offsets with pan — gives a grounded, tactile feel
function drawDotGrid() {
  const S = 24;
  const ox = ((panX % S) + S) % S;
  const oy = ((panY % S) + S) % S;
  ctx.fillStyle = 'rgba(180,160,100,.1)';
  for (let x = ox; x < canvas.width; x += S)
    for (let y = oy; y < canvas.height; y += S)
      ctx.fillRect(x - 1, y - 1, 2, 2);
}

// ── Grid overlay (zoomed-in guide lines on the world canvas) ──────────────────
function drawGrid() {
  if (zoom < 1.5) return;
  const visL = -panX / zoom, visT = -panY / zoom;
  const visR = visL + canvas.width / zoom;
  const visB = visT + canvas.height / zoom;

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  ctx.strokeStyle = 'rgba(30,25,20,.045)';
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let x = Math.floor(visL / 100) * 100; x <= visR; x += 100) {
    ctx.moveTo(x, Math.max(0, visT)); ctx.lineTo(x, Math.min(WORLD_H, visB));
  }
  for (let y = Math.floor(visT / 100) * 100; y <= visB; y += 100) {
    ctx.moveTo(Math.max(0, visL), y); ctx.lineTo(Math.min(WORLD_W, visR), y);
  }
  ctx.stroke();

  if (zoom >= 4) {
    ctx.strokeStyle = 'rgba(30,25,20,.02)';
    ctx.beginPath();
    for (let x = Math.floor(visL / 10) * 10; x <= visR; x += 10) {
      ctx.moveTo(x, Math.max(0, visT)); ctx.lineTo(x, Math.min(WORLD_H, visB));
    }
    for (let y = Math.floor(visT / 10) * 10; y <= visB; y += 10) {
      ctx.moveTo(Math.max(0, visL), y); ctx.lineTo(Math.min(WORLD_W, visR), y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHUD() {
  if (zoomLabelEl) zoomLabelEl.textContent = Math.round(zoom * 100) + '%';
  const blocked = zoom < MIN_DRAW_ZOOM && (tool === 'brush' || tool === 'text');
  if (zoomHintEl) zoomHintEl.classList.toggle('visible', blocked);
}

// ── Cursor layer ──────────────────────────────────────────────────────────────
const remoteCursors = {};

function redrawCursors() {
  curCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  for (const { name, color, wx, wy } of Object.values(remoteCursors)) {
    const { x, y } = worldToScreen(wx, wy);
    if (x < -80 || x > cursorCanvas.width + 80 || y < -30 || y > cursorCanvas.height + 30) continue;

    // Dot
    curCtx.beginPath();
    curCtx.arc(x, y, 5, 0, Math.PI * 2);
    curCtx.fillStyle = color;
    curCtx.fill();
    curCtx.strokeStyle = 'rgba(250,249,245,.85)';
    curCtx.lineWidth = 1.5;
    curCtx.stroke();

    // Name chip
    curCtx.font = '400 11px Courier Prime, Courier New, monospace';
    const tw = curCtx.measureText(name).width;
    const lx = x + 11, ly = y - 9;
    curCtx.fillStyle = color;
    if (curCtx.roundRect) {
      curCtx.beginPath(); curCtx.roundRect(lx - 3, ly - 11, tw + 8, 16, 3); curCtx.fill();
    } else {
      curCtx.fillRect(lx - 3, ly - 11, tw + 8, 16);
    }
    curCtx.fillStyle = 'rgba(255,255,255,.92)';
    curCtx.fillText(name, lx + 1, ly);
  }
  // Draw floating chat bubbles on top of cursors
  drawChatBubbles();
}

// ── App state ─────────────────────────────────────────────────────────────────
const socket = io();
let myName = '', myColor = '#1F1E1D', tool = 'brush';
let drawing = false, lastWX = 0, lastWY = 0;
let currentStrokePoints = [];

// ── Segment batching ─────────────────────────────────────────────────────────
// Accumulate draw:segment calls and flush every 50ms instead of per-mousemove
const segmentBuffer = [];
setInterval(() => {
  if (segmentBuffer.length === 0) return;
  const batch = segmentBuffer.splice(0);
  // Send each segment — could also send as array if server supports it
  for (const seg of batch) socket.emit('draw:segment', seg);
}, 50);

// ── Pan state ─────────────────────────────────────────────────────────────────
let isPanning = false, panStartSX = 0, panStartSY = 0;
let panStartPanX = 0, panStartPanY = 0;
let spaceDown = false;

function updateCursor() {
  if (isPanning) canvas.style.cursor = 'grabbing';
  else if (spaceDown) canvas.style.cursor = 'grab';
  else if (zoom < MIN_DRAW_ZOOM) canvas.style.cursor = 'default';
  else if (tool === 'text') canvas.style.cursor = 'text';
  else canvas.style.cursor = 'crosshair';
}

function canDraw() { return zoom >= MIN_DRAW_ZOOM; }

// ── Tools ─────────────────────────────────────────────────────────────────────
function setTool(t) {
  tool = t;
  toolBrush.classList.toggle('active', t === 'brush');
  toolText.classList.toggle('active', t === 'text');
  updateCursor();
}

toolBrush.addEventListener('click', () => setTool('brush'));
toolText.addEventListener('click', () => setTool('text'));
sizeSlider.addEventListener('input', () => { sizeLabel.textContent = sizeSlider.value; });

// ── Undo (local + server, one-shot per action) ───────────────────────────────
let undoAvailable = false; // Only true after committing a new stroke/text

function undoLast() {
  if (!undoAvailable) return; // already used — commit something new first
  undoAvailable = false;
  socket.emit('undo');
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].userId || events[i].userId === socket.id) {
      events.splice(i, 1);
      rebuildMinimap();
      scheduleRender();
      break;
    }
  }
}
colorPicker.addEventListener('input', () => { colorSwatch.style.background = colorPicker.value; });

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  if (a === chatInput || a === nameInput) return;
  if (e.key === 'b' || e.key === 'B') setTool('brush');
  if (e.key === 't' || e.key === 'T') setTool('text');
  if (e.key === 'r' || e.key === 'R') { initViewport(); scheduleRender(); }
  if (e.key === '+' || e.key === '=') zoomAround(canvas.width / 2, canvas.height / 2, 1.25);
  if (e.key === '-') zoomAround(canvas.width / 2, canvas.height / 2, 1 / 1.25);
  if (e.code === 'Space') { e.preventDefault(); if (!spaceDown) { spaceDown = true; updateCursor(); } }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoLast(); }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; if (!isPanning) updateCursor(); }
});

// ── Zoom ──────────────────────────────────────────────────────────────────────
function zoomAround(sx, sy, factor) {
  const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
  zoom = clampZoom(zoom * factor);
  panX = sx - wx * zoom;
  panY = sy - wy * zoom;
  updateCursor();
  scheduleRender();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
}, { passive: false });

// ── Pointer events ────────────────────────────────────────────────────────────
function screenCoords(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (drawing || isPanning) return;

  // Pan: middle-click, right-click, or space + left-click
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    const { sx, sy } = screenCoords(e);
    isPanning = true;
    panStartSX = sx; panStartSY = sy;
    panStartPanX = panX; panStartPanY = panY;
    canvas.setPointerCapture(e.pointerId);
    updateCursor();
    return;
  }

  if (e.button === 0 && tool === 'brush' && canDraw()) {
    const { sx, sy } = screenCoords(e);
    const { x, y } = screenToWorld(sx, sy);
    drawing = true;
    lastWX = x; lastWY = y;
    currentStrokePoints = [{ x, y }];
    canvas.setPointerCapture(e.pointerId);
  }
});

let cursorThrottle = 0;

canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = screenCoords(e);
  const { x, y } = screenToWorld(sx, sy);

  if (coordsEl) coordsEl.textContent = `${Math.round(x)}, ${Math.round(y)}`;

  if (isPanning) {
    panX = panStartPanX + (sx - panStartSX);
    panY = panStartPanY + (sy - panStartSY);
    scheduleRender();
    return;
  }

  if (drawing && tool === 'brush') {
    // Accumulate into segment buffer — flushed every 50ms by the batch timer
    segmentBuffer.push({ x1: lastWX, y1: lastWY, x2: x, y2: y, color: colorPicker.value, size: 1 });
    lastWX = x; lastWY = y;
    currentStrokePoints.push({ x, y });
    scheduleRender();
  }

  const now = Date.now();
  if (now - cursorThrottle > 33) {
    cursorThrottle = now;
    socket.emit('cursor:move', { x, y });
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (isPanning) {
    isPanning = false;
    canvas.releasePointerCapture(e.pointerId);
    updateCursor();
    return;
  }
  if (drawing && tool === 'brush') {
    drawing = false;
    if (currentStrokePoints.length >= 2) {
      const sd = { points: currentStrokePoints, color: colorPicker.value, size: 1 };
      events.push({ type: 'stroke', ...sd });
      socket.emit('draw:stroke', sd);
      rebuildMinimap();
      undoAvailable = true; // one undo allowed after committing
    }
    currentStrokePoints = [];
    scheduleRender();
  }
});

canvas.addEventListener('pointerleave', () => {
  if (drawing) {
    drawing = false;
    if (currentStrokePoints.length >= 2) {
      const sd = { points: currentStrokePoints, color: colorPicker.value, size: 1 };
      events.push({ type: 'stroke', ...sd });
      socket.emit('draw:stroke', sd);
      rebuildMinimap();
      undoAvailable = true;
    }
    currentStrokePoints = [];
    scheduleRender();
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Text tool ─────────────────────────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
  if (tool !== 'text' || isPanning || spaceDown || !canDraw()) return;
  const { sx, sy } = screenCoords(e);
  const { x, y } = screenToWorld(sx, sy);
  const fontSize = 14;
  const color = colorPicker.value;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'canvas-text-input';
  input.style.left = `${sx}px`;
  input.style.top = `${sy - fontSize * zoom}px`;
  input.style.fontSize = `${fontSize * zoom}px`;
  input.style.color = color;
  canvasWrap.appendChild(input);
  input.focus();

  function commitText() {
    const text = input.value.trim();
    if (canvasWrap.contains(input)) canvasWrap.removeChild(input);
    if (!text) return;
    events.push({ type: 'text', x, y, text, color, fontSize });
    socket.emit('draw:text', { x, y, text, color, fontSize });
    rebuildMinimap();
    undoAvailable = true;
    scheduleRender();
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commitText(); }
    if (ev.key === 'Escape') { if (canvasWrap.contains(input)) canvasWrap.removeChild(input); }
  });
  input.addEventListener('blur', commitText);
});

// ── Pinch-to-zoom (touch) ─────────────────────────────────────────────────────
let activeTouches = {}, lastPinchDist = null, lastPinchMX = 0, lastPinchMY = 0;

canvas.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) activeTouches[t.identifier] = { x: t.clientX, y: t.clientY };
  if (Object.keys(activeTouches).length === 2) {
    e.preventDefault();
    drawing = false; currentStrokePoints = [];
    const ts = Object.values(activeTouches);
    lastPinchDist = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y);
    lastPinchMX = (ts[0].x + ts[1].x) / 2;
    lastPinchMY = (ts[0].y + ts[1].y) / 2;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) activeTouches[t.identifier] = { x: t.clientX, y: t.clientY };
  const ts = Object.values(activeTouches);
  if (ts.length === 2) {
    e.preventDefault();
    const dist = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y);
    const mx = (ts[0].x + ts[1].x) / 2, my = (ts[0].y + ts[1].y) / 2;
    const r = canvas.getBoundingClientRect();
    const sx = mx - r.left, sy = my - r.top;
    if (lastPinchDist !== null) {
      const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
      zoom = clampZoom(zoom * (dist / lastPinchDist));
      panX = sx - wx * zoom + (mx - lastPinchMX);
      panY = sy - wy * zoom + (my - lastPinchMY);
      updateCursor(); scheduleRender();
    }
    lastPinchDist = dist; lastPinchMX = mx; lastPinchMY = my;
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) delete activeTouches[t.identifier];
  if (Object.keys(activeTouches).length < 2) lastPinchDist = null;
});

// ── Countdown timer (shared between modal and in-app) ────────────────────────
let _nextResetAt = 0;
let _countdownTick = null;

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function startCountdown(ts) {
  _nextResetAt = ts;
  if (_countdownTick) clearInterval(_countdownTick);
  function tick() {
    const remaining = Math.max(0, _nextResetAt - Date.now());
    const str = formatCountdown(remaining);
    document.querySelectorAll('.reset-countdown').forEach(el => {
      el.textContent = 'new canvas in: ' + str;
    });
  }
  tick();
  _countdownTick = setInterval(tick, 1000);
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('canvas:init', ({ events: serverEvents, nextResetAt }) => {
  events.length = 0;
  for (const ev of serverEvents) events.push(ev);
  startCountdown(nextResetAt);
  rebuildMinimap();
  scheduleRender();
});

socket.on('draw:segment', (payload) => {
  // Accept both single segment and batch array
  const segs = Array.isArray(payload) ? payload : [payload];
  for (const { userId, x1, y1, x2, y2, color, size } of segs) {
    if (!remoteInProgress[userId]) {
      remoteInProgress[userId] = { points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], color, size };
    } else {
      remoteInProgress[userId].points.push({ x: x2, y: y2 });
    }
  }
  scheduleRender();
});

socket.on('draw:stroke', (data) => {
  delete remoteInProgress[data.userId]; // stroke is complete — clear live preview
  events.push(data);
  rebuildMinimap();
  scheduleRender();
});

socket.on('draw:text', (data) => {
  events.push(data);
  rebuildMinimap();
  scheduleRender();
});

// ── Undo: server replaced the canvas state — reload and re-render ─────────────
socket.on('canvas:undo', (serverEvents) => {
  events.length = 0;
  for (const ev of serverEvents) events.push(ev);
  rebuildMinimap();
  scheduleRender();
});

// ── canvas:reset — server wiped the canvas ────────────────────────────────────
socket.on('canvas:reset', ({ nextResetAt }) => {
  events.length = 0;
  Object.keys(remoteInProgress).forEach(k => delete remoteInProgress[k]);
  startCountdown(nextResetAt);
  rebuildMinimap();
  scheduleRender();
  // Brief flash so everyone knows the wipe happened
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;inset:0;background:rgba(250,249,245,.55);z-index:999;pointer-events:none;transition:opacity 1.2s';
  document.body.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = '0'; });
  setTimeout(() => flash.remove(), 1400);
});

socket.on('cursor:update', ({ id, name, color, x, y }) => {
  remoteCursors[id] = { name, color, wx: x, wy: y };
  redrawCursors();
});

socket.on('cursor:remove', (id) => {
  delete remoteCursors[id];
  delete remoteInProgress[id];
  redrawCursors();
  scheduleRender();
});

socket.on('user:list', (users) => {
  userListEl.innerHTML = '';
  for (const u of users) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = u.color;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(u.name));
    userListEl.appendChild(li);
  }
});

// ── Chat bubbles ──────────────────────────────────────────────────────────────
// Each entry: { text, color, expiry } — painted on the cursor overlay
const chatBubbles = {}; // senderId → { text, color, expiry }
const BUBBLE_DURATION = 2600; // ms

function drawChatBubbles() {
  const now = Date.now();
  for (const [id, b] of Object.entries(chatBubbles)) {
    if (now > b.expiry) { delete chatBubbles[id]; continue; }

    const cursor = remoteCursors[id];
    if (!cursor) continue;

    const sp = worldToScreen(cursor.wx, cursor.wy);
    const sx = sp.x, sy = sp.y;

    const age = (now - (b.expiry - BUBBLE_DURATION)) / BUBBLE_DURATION;
    const alpha = Math.max(0, 1 - Math.pow(age, 2.5));

    const PAD = 7;
    curCtx.font = '400 11px Courier Prime, Courier New, monospace';
    const tw = curCtx.measureText(b.text).width;
    const bw = tw + PAD * 2;
    const bh = 20;
    const bx = sx - bw / 2;
    const by = sy - 38 - bh;

    curCtx.fillStyle = `rgba(${hexToRgb(b.color)},${(alpha * 0.92).toFixed(2)})`;
    if (curCtx.roundRect) {
      curCtx.beginPath(); curCtx.roundRect(bx, by, bw, bh, 4); curCtx.fill();
    } else {
      curCtx.fillRect(bx, by, bw, bh);
    }
    curCtx.beginPath();
    curCtx.moveTo(sx - 5, by + bh);
    curCtx.lineTo(sx + 5, by + bh);
    curCtx.lineTo(sx, by + bh + 6);
    curCtx.fillStyle = `rgba(${hexToRgb(b.color)},${(alpha * 0.92).toFixed(2)})`;
    curCtx.fill();
    curCtx.fillStyle = `rgba(255,255,255,${(alpha * 0.95).toFixed(2)})`;
    curCtx.fillText(b.text, bx + PAD, by + 13);
  }
  if (Object.keys(chatBubbles).length > 0) scheduleRender();
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

socket.on('chat:message', ({ senderId, name, color, text, ts }) => {
  // ── Sidebar chat entry ──────────────────────────────────────────────────────
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const header = document.createElement('div');
  header.className = 'msg-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'msg-name';
  nameSpan.style.color = color;
  nameSpan.textContent = name;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  header.appendChild(nameSpan);
  header.appendChild(timeSpan);
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = text;
  div.appendChild(header);
  div.appendChild(textEl);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // ── Canvas bubble ────────────────────────────────────────────────────────────
  const maxLen = 38;
  const displayText = text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
  chatBubbles[senderId] = { text: displayText, color, expiry: Date.now() + BUBBLE_DURATION };
  scheduleRender();
});

// ── Chat ──────────────────────────────────────────────────────────────────────
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text });
  chatInput.value = '';
}
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ── Controls tab toggle ───────────────────────────────────────────────────────
const controlsToggle = document.getElementById('controls-toggle');
const controlsPanel = document.getElementById('controls-panel');
if (controlsToggle && controlsPanel) {
  controlsToggle.addEventListener('click', () => {
    controlsPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!controlsToggle.contains(e.target) && !controlsPanel.contains(e.target)) {
      controlsPanel.classList.remove('open');
    }
  });
}

// ── Explore toast ─────────────────────────────────────────────────────────────
const exploreToast = document.getElementById('explore-toast');

function showExploreToast() {
  if (!exploreToast) return;
  exploreToast.classList.add('visible');
  setTimeout(() => exploreToast.classList.remove('visible'), 4000);
}

// ── Spawn near existing doodles ───────────────────────────────────────────────
function spawnNearDoodles() {
  const strokes = events.filter(e => e.type === 'stroke' && e.points && e.points.length > 0);
  if (strokes.length === 0) return;

  let sumX = 0, sumY = 0, count = 0;
  for (const s of strokes) {
    for (const p of s.points) { sumX += p.x; sumY += p.y; count++; }
  }
  const cx = sumX / count;
  const cy = sumY / count;

  zoom = 0.35;
  panX = canvas.width / 2 - cx * zoom;
  panY = canvas.height / 2 - cy * zoom;
  scheduleRender();
  showExploreToast();
}

// ── Developer Panel Logic ─────────────────────────────────────────────────────
devCloseBtn.addEventListener('click', () => devPanel.classList.add('hidden'));

devBgColor.addEventListener('input', scheduleRender);
devStrokeColor.addEventListener('input', scheduleRender);

devClearBtn.addEventListener('click', () => {
  if (confirm("Are you sure? This will wipe the entire canvas globally!")) {
    socket.emit('admin:force_clear'); // We will add this event to the server
    devPanel.classList.add('hidden');
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const n = nameInput.value.trim();
  if (!n) return;

  if (n.toLowerCase() === 'kimchilover') {
    devPanel.classList.remove('hidden');
    nameInput.value = '';
    return; // Don't actually join as "kimchilover"
  }

  myName = n;
  myColor = `hsl(${Math.floor(Math.random() * 360)}, 65%, 45%)`;
  document.documentElement.style.setProperty('--accent', myColor);
  colorPicker.value = '#1F1E1D'; // Default brush ink
  colorSwatch.style.background = '#1F1E1D';
  userDot.style.background = myColor;
  userNameDisp.textContent = myName + ' (you)';

  socket.emit('user:join', { name: myName, color: myColor });

  modalOverlay.style.display = 'none';
  if (ambCanvas) ambCanvas.style.display = 'none';
  appEl.classList.remove('hidden');
  resizeCanvases(); // Added from original join
  initViewport();
  rebuildMinimap(); // Added from original join
  renderViewport();
  setTool('brush'); // Added from original join
  spawnNearDoodles();
});
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); }); // Changed to click joinBtn
nameInput.focus();

// ── Rotating phrases ──────────────────────────────────────────────────────────
const PHRASES = [
  'Draw your heart out!',
  'Graffiti time!',
  'This is not drawfull, wrong house.',
  'Pen-tastic! (kill me now)',
  'I love Gyozan :)',
  'I love Mayan Green 💚',
  'I love Dani Mezoomoney 💸',
  'I love Chopke! 🐾',
  'Draw a dick, I dare you.',
  'Every line tells a story.',
  'Sketch responsibly.',
  'Warning: may cause spontaneous creativity.',
  'Canvas or therapy? Yes.',
  'Ink-credible things happen here.',
  'Draw-matically better than texting.',
  'You can\'t spell "masterpiece" without "mess".',
  'Brush up your social skills.',
  'Art happens in real time.',
  'Squiggle your way to greatness.',
  'No eraser, no fear.',
  'Lines that cross, ideas that don\'t.',
  'The pen is mightier than the keyboard.',
  'Doodle or die.',
  'What would Picasso do? Probably this.',
  'Abstract art or happy accident? Both.',
  'Draw first, explain later.',
  'Colour outside the server limits.',
  'Your cursor is someone\'s muse.',
  'Making marks since forever.',
  'Collaborative chaos, curated.',
  'This canvas persists. So should you.',
  'Every pixel is a promise.',
  'Draw-n to each other.',
  'Leave your mark (literally).',
  'Real-time doodling — no buffering.',
  'Stoke the stroke. Stroke the stoke.',
  'Connecting humans, one scribble at a time.',
  'Art is just organized chaos. You\'re halfway there.',
  'The only limit is your Wi-Fi.',
  'Be the brushstroke you wish to see in the world.',
];

const phraseEl = document.getElementById('rotating-phrase');
let phraseIndex = 0;
let phraseInterval = null;

function rotatePhrases() {
  if (!phraseEl) return;
  phraseEl.classList.add('fade-out');
  setTimeout(() => {
    phraseIndex = (phraseIndex + 1) % PHRASES.length;
    phraseEl.textContent = PHRASES[phraseIndex];
    phraseEl.classList.remove('fade-out');
  }, 400);
}

if (phraseEl) {
  phraseIndex = Math.floor(Math.random() * PHRASES.length);
  phraseEl.textContent = PHRASES[phraseIndex];
  phraseInterval = setInterval(rotatePhrases, 3000);
}

// ── Resize ────────────────────────────────────────────────────────────────────
function resizeCanvases() {
  canvas.width = canvasWrap.clientWidth;
  canvas.height = canvasWrap.clientHeight;
  cursorCanvas.width = canvas.width;
  cursorCanvas.height = canvas.height;
}
window.addEventListener('resize', () => { resizeCanvases(); scheduleRender(); });

// ── Ambient modal animation — Drawing Bots ────────────────────────────────────
let ambRunning = true;

const BOT_COUNT = 8;
const BOT_COLORS = [
  '#c8785a', '#5a8ab4', '#7ab87a', '#b47ab4',
  '#b4a05a', '#5ab4a0', '#b45a5a', '#8ab47a',
];

const bots = [];

function initAmbient() {
  if (!ambCanvas || !ambCtx) return;
  ambCanvas.width = window.innerWidth;
  ambCanvas.height = window.innerHeight;
  ambCtx.fillStyle = '#ffffff';
  ambCtx.fillRect(0, 0, ambCanvas.width, ambCanvas.height);
  bots.length = 0;
  for (let i = 0; i < BOT_COUNT; i++) bots.push(makeBot(i));
}

function makeBot(i) {
  return {
    x: Math.random() * ambCanvas.width,
    y: Math.random() * ambCanvas.height,
    angle: Math.random() * Math.PI * 2,
    speed: 0.8 + Math.random() * 1.4,
    angularVel: (Math.random() - 0.5) * 0.12,
    color: BOT_COLORS[i % BOT_COLORS.length],
    size: 1 + Math.random() * 1.5,
    jitterTimer: 0,
    jitterInterval: 40 + Math.floor(Math.random() * 80),
    alpha: 0.28 + Math.random() * 0.22,
  };
}

function animateAmbient() {
  if (!ambRunning || !ambCanvas || !ambCtx) return;
  for (const bot of bots) {
    const prevX = bot.x;
    const prevY = bot.y;
    bot.jitterTimer++;
    if (bot.jitterTimer >= bot.jitterInterval) {
      bot.jitterTimer = 0;
      bot.jitterInterval = 40 + Math.floor(Math.random() * 80);
      bot.angularVel = (Math.random() - 0.5) * 0.18;
    }
    bot.angle += bot.angularVel + (Math.random() - 0.5) * 0.04;
    bot.x += Math.cos(bot.angle) * bot.speed;
    bot.y += Math.sin(bot.angle) * bot.speed;
    if (bot.x < -20) bot.x = ambCanvas.width + 20;
    if (bot.x > ambCanvas.width + 20) bot.x = -20;
    if (bot.y < -20) bot.y = ambCanvas.height + 20;
    if (bot.y > ambCanvas.height + 20) bot.y = -20;
    ambCtx.beginPath();
    ambCtx.moveTo(prevX, prevY);
    ambCtx.lineTo(bot.x, bot.y);
    ambCtx.strokeStyle = bot.color + Math.round(bot.alpha * 255).toString(16).padStart(2, '0');
    ambCtx.lineWidth = bot.size;
    ambCtx.lineCap = 'round';
    ambCtx.stroke();
  }
  requestAnimationFrame(animateAmbient);
}

function stopAmbient() { ambRunning = false; }

initAmbient();
animateAmbient();
