/* ── Eternal Archive — client ─────────────────────────────────────────────── */

const WORLD_W = 4000, WORLD_H = 3000;

// ── Socket (for 1UP animations) ───────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

// ── DOM refs ──────────────────────────────────────────────────────────────────
const listView       = document.getElementById('list-view');
const viewerEl       = document.getElementById('viewer');
const archiveGrid    = document.getElementById('archive-grid');
const noArchivesEl   = document.getElementById('no-archives');
const loadingMsgEl   = document.getElementById('loading-msg');

const avCanvas       = document.getElementById('av-canvas');
const avOverlay      = document.getElementById('av-overlay');
const avWrap         = document.getElementById('av-wrap');
const avCtx          = avCanvas.getContext('2d');
const ovCtx          = avOverlay.getContext('2d');

const avBackBtn      = document.getElementById('av-back-btn');
const avDateHud      = document.getElementById('av-date-hud');
const avZoomLabel    = document.getElementById('av-zoom-label');
const avCoordsEl     = document.getElementById('av-coords');
const avSidebarDate  = document.getElementById('av-sidebar-date');
const avStatsList    = document.getElementById('av-stats-list');
const avContribList  = document.getElementById('av-contributors-list');
const avOneupInfo    = document.getElementById('av-oneup-info');

const avTooltip      = document.getElementById('av-tooltip');
const avTooltipName  = document.getElementById('av-tooltip-name');
const avTooltipOneup = document.getElementById('av-tooltip-oneup');

// ── Viewport state ────────────────────────────────────────────────────────────
let panX = 0, panY = 0, zoom = 1;
let isPanning = false, panStartSX = 0, panStartSY = 0, panStartPanX = 0, panStartPanY = 0;
let spaceDown = false;

function screenToWorld(sx, sy) { return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }; }
function worldToScreen(wx, wy) { return { x: wx * zoom + panX, y: wy * zoom + panY }; }
function clampZoom(z)          { return Math.max(0.04, Math.min(14, z)); }

function initViewport() {
  const pad = 48;
  zoom = Math.min((avCanvas.width - pad * 2) / WORLD_W, (avCanvas.height - pad * 2) / WORLD_H);
  panX = (avCanvas.width  - WORLD_W * zoom) / 2;
  panY = (avCanvas.height - WORLD_H * zoom) / 2;
}

function zoomAround(sx, sy, factor) {
  const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
  zoom = clampZoom(zoom * factor);
  panX = sx - wx * zoom;
  panY = sy - wy * zoom;
  scheduleRender();
}

// ── Rendering primitives ──────────────────────────────────────────────────────
function renderStroke(c, { points, color, size, cap = 'round' }) {
  if (!points || points.length < 2) return;
  c.beginPath();
  c.strokeStyle = color;
  c.lineWidth   = size;
  c.lineCap     = cap;
  c.lineJoin    = cap === 'square' ? 'miter' : 'round';
  c.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
  c.stroke();
}

function renderText(c, { x, y, text, color, fontSize }) {
  c.fillStyle = color;
  c.font = `${fontSize}px 'Courier Prime', 'Courier New', monospace`;
  c.fillText(text, x, y);
}

// ── Render pipeline ───────────────────────────────────────────────────────────
let archiveEvents = [];
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame() {
  renderScheduled = false;

  // Background
  avCtx.fillStyle = '#f5f5f0';
  avCtx.fillRect(0, 0, avCanvas.width, avCanvas.height);

  // Dot grid
  const S = 24;
  const ox = ((panX % S) + S) % S, oy = ((panY % S) + S) % S;
  avCtx.fillStyle = 'rgba(180,160,100,.1)';
  for (let x = ox; x < avCanvas.width; x += S)
    for (let y = oy; y < avCanvas.height; y += S)
      avCtx.fillRect(x - 1, y - 1, 2, 2);

  avCtx.save();
  avCtx.translate(panX, panY);
  avCtx.scale(zoom, zoom);

  // World canvas surface
  avCtx.fillStyle = '#FAFAF7';
  avCtx.fillRect(0, 0, WORLD_W, WORLD_H);

  for (const ev of archiveEvents) {
    if (ev.type === 'stroke') renderStroke(avCtx, ev);
    if (ev.type === 'text')   renderText(avCtx, ev);
  }

  // Border
  avCtx.strokeStyle = 'rgba(0,0,0,.12)';
  avCtx.lineWidth = 3 / zoom;
  avCtx.strokeRect(0, 0, WORLD_W, WORLD_H);

  avCtx.restore();

  // HUD
  avZoomLabel.textContent = Math.round(zoom * 100) + '%';

  // 1UP overlay
  renderOverlay();
}

// ── 1UP animation ─────────────────────────────────────────────────────────────
const activeOneups = [];

function renderOverlay() {
  ovCtx.clearRect(0, 0, avOverlay.width, avOverlay.height);
  const now = Date.now(), DURATION = 2200;
  for (let i = activeOneups.length - 1; i >= 0; i--) {
    const up  = activeOneups[i];
    const age = now - up.startTime;
    if (age > DURATION) { activeOneups.splice(i, 1); continue; }
    const t     = age / DURATION;
    const alpha = Math.pow(1 - t, 1.4);
    const sp    = worldToScreen(up.x, up.y);
    const fy    = sp.y - t * 72;
    const fx    = sp.x + Math.sin(age / 60) * 5;
    ovCtx.save();
    ovCtx.globalAlpha = alpha;
    ovCtx.font = `bold 17px 'Courier Prime', monospace`;
    ovCtx.strokeStyle = 'rgba(255,255,255,.85)';
    ovCtx.lineWidth = 3;
    ovCtx.strokeText('1UP!', fx - 18, fy);
    ovCtx.fillStyle = up.color;
    ovCtx.fillText('1UP!', fx - 18, fy);
    ovCtx.restore();
  }
  if (activeOneups.length > 0) scheduleRender();
}

socket.on('draw:oneup', ({ name, color, x, y }) => {
  activeOneups.push({ name, color, x, y, startTime: Date.now() });
  scheduleRender();
});

// ── Hit detection ─────────────────────────────────────────────────────────────
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function findStrokeAt(wx, wy) {
  const threshold = 8 / zoom;
  for (let i = archiveEvents.length - 1; i >= 0; i--) {
    const ev = archiveEvents[i];
    if (ev.type !== 'stroke' || !ev.userName || !ev.points || ev.points.length < 2) continue;
    for (let j = 1; j < ev.points.length; j++) {
      if (distToSegment(wx, wy, ev.points[j - 1].x, ev.points[j - 1].y, ev.points[j].x, ev.points[j].y) < threshold)
        return ev;
    }
  }
  return null;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
let hoveredStroke = null, tooltipPinned = false, hideTooltipTimer = null, hoverThrottle = 0;

function showTooltip(ev, sx, sy) {
  if (hideTooltipTimer) { clearTimeout(hideTooltipTimer); hideTooltipTimer = null; }
  hoveredStroke = ev;
  avTooltipName.textContent = `drawn by ${ev.userName}`;
  avTooltip.style.left = `${sx + 14}px`;
  avTooltip.style.top  = `${sy - 38}px`;
  avTooltip.classList.add('visible');
}

function scheduleHide() {
  if (tooltipPinned) return;
  if (hideTooltipTimer) clearTimeout(hideTooltipTimer);
  hideTooltipTimer = setTimeout(() => {
    hoveredStroke = null;
    avTooltip.classList.remove('visible');
  }, 150);
}

avTooltip.addEventListener('mouseenter', () => {
  tooltipPinned = true;
  if (hideTooltipTimer) { clearTimeout(hideTooltipTimer); hideTooltipTimer = null; }
});
avTooltip.addEventListener('mouseleave', () => { tooltipPinned = false; scheduleHide(); });

// ── 1UP spending ──────────────────────────────────────────────────────────────
let myTokens = parseInt(localStorage.getItem('ec_tokens') || '0', 10);
const myName  = localStorage.getItem('ec_name') || '';
const myColor = '#c8785a';

function updateOneupBtn() {
  const hasToks = myTokens > 0;
  avTooltipOneup.style.opacity      = hasToks ? '1' : '0.35';
  avTooltipOneup.style.pointerEvents = hasToks ? 'auto' : 'none';
  avTooltipOneup.title = hasToks ? `Give a 1UP! (×${myTokens} remaining)` : 'No 1UPs left';
  if (avOneupInfo) {
    avOneupInfo.textContent = myName
      ? `Logged in as ${myName} · ×${myTokens} 1UPs`
      : 'Visit the canvas first to earn 1UPs.';
  }
}
updateOneupBtn();

avTooltipOneup.addEventListener('click', () => {
  if (!hoveredStroke || myTokens <= 0) return;
  myTokens--;
  localStorage.setItem('ec_tokens', myTokens);
  updateOneupBtn();
  const mid = hoveredStroke.points[Math.floor(hoveredStroke.points.length / 2)];
  socket.emit('archive:oneup', { x: mid.x, y: mid.y, name: myName || '✦', color: myColor });
  avTooltip.classList.remove('visible');
  tooltipPinned = false;
  hoveredStroke = null;
});

// ── Pointer events ────────────────────────────────────────────────────────────
function screenCoords(e) {
  const r = avCanvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

avCanvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    const { sx, sy } = screenCoords(e);
    isPanning = true;
    panStartSX = sx; panStartSY = sy;
    panStartPanX = panX; panStartPanY = panY;
    avCanvas.setPointerCapture(e.pointerId);
    avCanvas.style.cursor = 'grabbing';
  }
});

avCanvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = screenCoords(e);
  const { x, y }   = screenToWorld(sx, sy);
  avCoordsEl.textContent = `${Math.round(x)}, ${Math.round(y)}`;

  if (isPanning) {
    panX = panStartPanX + (sx - panStartSX);
    panY = panStartPanY + (sy - panStartSY);
    scheduleRender();
    return;
  }

  if (e.pointerType !== 'touch') {
    const now = Date.now();
    if (now - hoverThrottle > 80) {
      hoverThrottle = now;
      const hit = findStrokeAt(x, y);
      if (hit) showTooltip(hit, sx, sy);
      else scheduleHide();
    } else if (hoveredStroke) {
      avTooltip.style.left = `${sx + 14}px`;
      avTooltip.style.top  = `${sy - 38}px`;
    }
  }
});

avCanvas.addEventListener('pointerup', (e) => {
  if (isPanning) {
    isPanning = false;
    avCanvas.releasePointerCapture(e.pointerId);
    avCanvas.style.cursor = spaceDown ? 'grab' : 'default';
  }
});

avCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

avCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r  = avCanvas.getBoundingClientRect();
  zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
}, { passive: false });

// Touch pinch-to-zoom
let activeTouches = {}, lastPinchDist = null, lastPinchMX = 0, lastPinchMY = 0;

avCanvas.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) activeTouches[t.identifier] = { x: t.clientX, y: t.clientY };
  if (Object.keys(activeTouches).length === 2) {
    e.preventDefault();
    const ts = Object.values(activeTouches);
    lastPinchDist = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y);
    lastPinchMX = (ts[0].x + ts[1].x) / 2;
    lastPinchMY = (ts[0].y + ts[1].y) / 2;
  }
}, { passive: false });

avCanvas.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) activeTouches[t.identifier] = { x: t.clientX, y: t.clientY };
  const ts = Object.values(activeTouches);
  if (ts.length === 2) {
    e.preventDefault();
    const dist = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y);
    const mx   = (ts[0].x + ts[1].x) / 2, my = (ts[0].y + ts[1].y) / 2;
    const r    = avCanvas.getBoundingClientRect();
    const sx   = mx - r.left, sy = my - r.top;
    if (lastPinchDist !== null) {
      const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
      zoom = clampZoom(zoom * (dist / lastPinchDist));
      panX = sx - wx * zoom + (mx - lastPinchMX);
      panY = sy - wy * zoom + (my - lastPinchMY);
      scheduleRender();
    }
    lastPinchDist = dist; lastPinchMX = mx; lastPinchMY = my;
  }
}, { passive: false });

avCanvas.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) delete activeTouches[t.identifier];
  if (Object.keys(activeTouches).length < 2) lastPinchDist = null;
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R')   { initViewport(); scheduleRender(); }
  if (e.key === '+' || e.key === '=')   zoomAround(avCanvas.width / 2, avCanvas.height / 2, 1.25);
  if (e.key === '-')                    zoomAround(avCanvas.width / 2, avCanvas.height / 2, 1 / 1.25);
  if (e.code === 'Space')               { e.preventDefault(); spaceDown = true; avCanvas.style.cursor = 'grab'; }
  if (e.key === 'Escape')               showList();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; if (!isPanning) avCanvas.style.cursor = 'default'; }
});

// ── Resize ────────────────────────────────────────────────────────────────────
function resizeCanvases() {
  avCanvas.width  = avWrap.clientWidth;
  avCanvas.height = avWrap.clientHeight;
  avOverlay.width  = avCanvas.width;
  avOverlay.height = avCanvas.height;
}

window.addEventListener('resize', () => { resizeCanvases(); initViewport(); scheduleRender(); });

// ── Load archive ──────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

async function loadArchive(id) {
  archiveEvents = [];
  scheduleRender();

  try {
    const res  = await fetch(`/api/archives/${id}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    archiveEvents = data.events || [];

    const dateStr = fmtDate(data.savedAt);
    avDateHud.textContent      = dateStr;
    avSidebarDate.textContent  = dateStr;

    const s = data.stats || {};

    // Stats
    avStatsList.innerHTML = `
      <div class="av-stat-row">
        <span class="av-stat-label">Strokes</span>
        <span class="av-stat-val">${s.totalStrokes || 0}</span>
      </div>
      <div class="av-stat-row">
        <span class="av-stat-label">Text placements</span>
        <span class="av-stat-val">${s.totalTexts || 0}</span>
      </div>
      <div class="av-stat-row">
        <span class="av-stat-label">Total events</span>
        <span class="av-stat-val">${archiveEvents.length}</span>
      </div>
    `;

    // Top artists
    avContribList.innerHTML = '';
    const maxCount = (s.topArtists || [])[0]?.count || 1;
    for (const a of (s.topArtists || [])) {
      const pct = Math.round((a.count / maxCount) * 100);
      const li  = document.createElement('li');
      li.innerHTML = `
        <span class="dot" style="background:${a.color || '#888'}"></span>
        <div class="av-contrib-info">
          <div class="av-contrib-row">
            <span class="av-contrib-name">${escHtml(a.name)}</span>
            <span class="av-contrib-count">${a.count}</span>
          </div>
          <div class="av-contrib-bar"><div class="av-contrib-fill" style="width:${pct}%;background:${a.color || '#888'}"></div></div>
        </div>
      `;
      avContribList.appendChild(li);
    }

    // 1UP section
    updateOneupBtn();

    scheduleRender();
  } catch (err) {
    console.error('Failed to load archive:', err);
    avStatsList.innerHTML = '<div class="av-stat-row" style="color:#c8785a">Failed to load canvas.</div>';
  }
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showViewer(id) {
  listView.style.display  = 'none';
  viewerEl.style.display  = 'flex';
  resizeCanvases();
  initViewport();
  loadArchive(id);
  history.pushState({ archiveId: id }, '', `/archive#${id}`);
}

function showList() {
  viewerEl.style.display  = 'none';
  listView.style.display  = 'block';
  archiveEvents = [];
  history.pushState({}, '', '/archive');
}

avBackBtn.addEventListener('click', showList);

window.addEventListener('popstate', (e) => {
  const hash = window.location.hash.slice(1);
  if (hash) showViewer(hash);
  else showList();
});

// ── Archive list ──────────────────────────────────────────────────────────────
async function fetchArchives() {
  try {
    const res      = await fetch('/api/archives');
    const archives = await res.json();
    loadingMsgEl.style.display = 'none';

    if (archives.length === 0) {
      noArchivesEl.style.display = 'block';
      return;
    }

    archiveGrid.innerHTML = '';
    for (const arch of archives) {
      const card = document.createElement('div');
      card.className = 'archive-card';

      const dateStr  = fmtDate(arch.savedAt);
      const s        = arch.stats || {};
      const topNames = (s.topArtists || []).slice(0, 3).map(a =>
        `<li><span class="dot" style="background:${a.color || '#888'}"></span><span>${escHtml(a.name)}</span><span class="ac-count">${a.count}</span></li>`
      ).join('');

      card.innerHTML = `
        <div class="ac-date">${dateStr}</div>
        <div class="ac-stats">
          <span>${s.totalStrokes || 0} strokes</span>
          ${s.totalTexts ? `<span>${s.totalTexts} texts</span>` : ''}
        </div>
        ${topNames ? `<ul class="ac-artists">${topNames}</ul>` : ''}
        <button class="ac-explore-btn">Explore Day →</button>
      `;
      card.querySelector('.ac-explore-btn').addEventListener('click', () => showViewer(String(arch._id)));
      archiveGrid.appendChild(card);
    }
  } catch (err) {
    loadingMsgEl.textContent = 'Failed to load archives.';
    console.error(err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
viewerEl.style.display = 'none';
noArchivesEl.style.display = 'none';

fetchArchives();

const initialHash = window.location.hash.slice(1);
if (initialHash) {
  showViewer(initialHash);
}
