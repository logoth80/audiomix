'use strict';
/* ==========================================================================
   ui.js — timeline rendering, clip drag/trim/snap, ruler, inspector, wiring
   ========================================================================== */

const $ = id => document.getElementById(id);
const dpr = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));

const dom = {};
let clipEls = new Map();   // clipId -> { root, canvas, titleEl, clip }
let laneEls = new Map();   // trackId -> lane element
let viewSeconds = 60;
let widthPx = 4800;
let drag = null;           // active pointer drag descriptor
let snapGuideEl = null;

/* --------------------------------------------------------------- helpers */
function hexToRgb(h) {
  h = String(h || '#38bdf8').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex, target, t) {
  const a = hexToRgb(hex), b = hexToRgb(target);
  const c = a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
}
function timeToX(t) { return t * state.ppp; }
function xToTime(x) { return x / state.ppp; }

/** px offset of the timeline origin (t = 0) in client space. */
function laneOriginX() {
  return dom.inner.getBoundingClientRect().left + HEADER_W;
}
function clientXToTime(clientX) { return xToTime(clientX - laneOriginX()); }

/* ------------------------------------------------------------ rendering */
function syncCssVars() {
  const r = document.documentElement.style;
  r.setProperty('--header-w', HEADER_W + 'px');
  r.setProperty('--lane-h', LANE_H + 'px');
  r.setProperty('--lane-gap', LANE_GAP + 'px');
}

function layoutWidth() {
  const total = projectEnd();
  const avail = Math.max(200, (dom.scroll.clientWidth || 800) - HEADER_W);
  viewSeconds = Math.max(total + 2, avail / state.ppp, 8);
  widthPx = Math.round(viewSeconds * state.ppp);
}

function renderAll() {
  if (drag) return; // never rebuild DOM in the middle of a drag
  clipEls = new Map();
  laneEls = new Map();
  layoutWidth();
  dom.inner.style.width = (HEADER_W + widthPx) + 'px';
  renderRuler();
  renderLanes();
  renderPlayhead();
  renderEnd();
  dom.empty.hidden = state.tracks.length > 0 || countClips() > 0;
  renderStats();
  renderInspector();
}

function renderRuler() {
  const c = dom.ruler;
  const ratio = dpr();
  c.style.width = widthPx + 'px';
  c.width = Math.max(1, Math.round(widthPx * ratio));
  c.height = Math.round(RULER_H * ratio);
  const g = c.getContext('2d');
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, widthPx, RULER_H);
  g.fillStyle = '#0f1621';
  g.fillRect(0, 0, widthPx, RULER_H);

  // choose a tick step that stays legible at this zoom
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (s * state.ppp >= 78) { step = s; break; } }
  const sub = step / 5;

  g.lineWidth = 1;
  // sub ticks
  g.strokeStyle = '#243040';
  g.beginPath();
  for (let t = 0; t <= viewSeconds; t += sub) {
    const x = Math.round(timeToX(t)) + 0.5;
    g.moveTo(x, RULER_H - 6); g.lineTo(x, RULER_H);
  }
  g.stroke();
  // major ticks + labels
  g.strokeStyle = '#41546c';
  g.fillStyle = '#8ea3bb';
  g.font = '10px ui-monospace, Consolas, monospace';
  g.beginPath();
  for (let t = 0; t <= viewSeconds + 1e-6; t += step) {
    const x = Math.round(timeToX(t)) + 0.5;
    g.moveTo(x, RULER_H - 12); g.lineTo(x, RULER_H);
    const label = step >= 1
      ? (Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0'))
      : fmtTime(t);
    g.fillText(label, x + 3, 12);
  }
  g.stroke();
}

function renderLanes() {
  dom.lanes.innerHTML = '';
  // the playhead / end line / snap guide live inside .lanes and were just discarded
  dom.playhead = null;
  dom.endLine = null;
  snapGuideEl = null;
  for (const track of state.tracks) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.trackId = track.id;
    if (state.sel && state.sel.type === 'track' && state.sel.id === track.id) row.dataset.selected = 'track';
    row.style.setProperty('--tc', track.color);

    /* ---- header ---- */
    const head = document.createElement('div');
    head.className = 'lane-head';
    head.innerHTML =
      '<div class="lh-top">' +
        '<span class="swatch"></span>' +
        '<input class="lh-name" type="text" spellcheck="false" aria-label="Track name">' +
        '<span class="lh-btns">' +
          '<button class="tag-btn" data-act="mute" title="Mute track">M</button>' +
          '<button class="tag-btn" data-act="solo" title="Solo track">S</button>' +
        '</span>' +
      '</div>' +
      '<div class="lh-mid">' +
        '<input type="range" min="0" max="2" step="0.01" aria-label="Track volume">' +
        '<output class="lh-gain-out"></output>' +
      '</div>' +
      '<div class="lh-btns lh-foot">' +
        '<button class="mini-btn" data-act="up" title="Move track up">▲</button>' +
        '<button class="mini-btn" data-act="down" title="Move track down">▼</button>' +
        '<button class="mini-btn" data-act="add" title="Insert file at playhead on this track">＋</button>' +
        '<button class="mini-btn" data-act="clear" title="Remove all clips from this track">⌫</button>' +
        '<button class="mini-btn" data-act="del" title="Remove track">🗑</button>' +
      '</div>';
    head.querySelector('.lh-name').value = track.name;
    const rg = head.querySelector('.lh-mid input');
    rg.value = track.gain;
    head.querySelector('.lh-gain-out').textContent = Number(track.gain).toFixed(2);
    head.querySelector('[data-act=mute]').dataset.on = track.muted ? '1' : '0';
    head.querySelector('[data-act=solo]').dataset.on = track.solo ? 's' : '';

    head.addEventListener('pointerdown', e => {
      if (e.target.closest('input,button')) return;
      selectTrack(track.id);
      renderAll();
    });
    head.querySelector('.lh-name').addEventListener('input', e => {
      track.name = e.target.value;
      renderInspector();
    });
    rg.addEventListener('input', e => {
      track.gain = parseFloat(e.target.value);
      head.querySelector('.lh-gain-out').textContent = track.gain.toFixed(2);
      if (state.sel && state.sel.type === 'track') renderInspector();
    });
    head.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'mute') track.muted = !track.muted;
        else if (act === 'solo') track.solo = !track.solo;
        else if (act === 'up') moveTrack(track.id, -1);
        else if (act === 'down') moveTrack(track.id, +1);
        else if (act === 'clear') { track.clips.length = 0; }
        else if (act === 'del') { removeTrack(track.id); }
        else if (act === 'add') { dom.fileInput.dataset.targetTrack = track.id; dom.fileInput.click(); }
        renderAll();
      });
    });

    /* ---- lane ---- */
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.trackId = track.id;
    lane.style.width = widthPx + 'px';

    lane.addEventListener('pointerdown', e => {
      if (e.target !== lane) return;
      if (state.sel) { selectClip(null); renderAll(); }
    });

    for (const clip of track.clips) lane.appendChild(buildClipEl(clip, track));
    laneEls.set(track.id, lane);

    row.appendChild(head);
    row.appendChild(lane);
    dom.lanes.appendChild(row);
  }
  ensurePlayheadEl();
}

function buildClipEl(clip, track) {
  const root = document.createElement('div');
  root.className = 'clip';
  root.dataset.clipId = clip.id;
  if (state.sel && state.sel.type === 'clip' && state.sel.id === clip.id) root.dataset.sel = '1';
  root.style.setProperty('--c1', mix(track.color, '#16202c', 0.66));
  root.style.setProperty('--c2', mix(track.color, '#0b1017', 0.86));
  root.style.setProperty('--cb', mix(track.color, '#ffffff', 0.05));
  root.style.left = Math.round(timeToX(clip.start)) + 'px';
  root.style.width = Math.max(6, Math.round(clip.duration * state.ppp)) + 'px';

  const title = document.createElement('div');
  title.className = 'clip-title';
  title.innerHTML = '<b></b><span></span><button class="x" title="Remove clip">✕</button>';
  title.querySelector('b').textContent = clip.name;
  title.querySelector('span').textContent = fmtTime(clip.duration);
  title.querySelector('.x').addEventListener('click', e => {
    e.stopPropagation();
    removeClip(clip.id);
    renderAll();
  });

  const canvas = document.createElement('canvas');
  canvas.className = 'clip-wave';

  const hl = document.createElement('div'); hl.className = 'handle left'; hl.dataset.handle = 'l';
  const hr = document.createElement('div'); hr.className = 'handle right'; hr.dataset.handle = 'r';

  root.appendChild(title);
  root.appendChild(canvas);
  root.appendChild(hl);
  root.appendChild(hr);

  if (Math.abs(clip.gain - 1) > 0.001) {
    const flag = document.createElement('span');
    flag.className = 'clip-gain-flag';
    flag.textContent = (clip.gain * 100).toFixed(0) + '%';
    root.appendChild(flag);
  }

  root.addEventListener('pointerdown', e => startClipDrag(e, clip, track, root));
  requestAnimationFrame(() => drawWave(canvas, clip));
  clipEls.set(clip.id, { root, canvas, titleEl: title, clip, track });
  return root;
}

/* ------------------------------------------------------------ waveform */
function peakRange(info, t0, t1) {
  const b = info.bucket, sr = info.sampleRate;
  let i0 = Math.floor(t0 * sr / b), i1 = Math.ceil(t1 * sr / b) - 1;
  const last = info.peakMax.length - 1;
  if (i1 < i0) i1 = i0;
  i0 = clamp(i0, 0, last); i1 = clamp(i1, 0, last);
  let lo = 0, hi = 0;
  for (let i = i0; i <= i1; i += 1) {
    if (info.peakMin[i] < lo) lo = info.peakMin[i];
    if (info.peakMax[i] > hi) hi = info.peakMax[i];
  }
  return [lo, hi];
}

function drawWave(canvas, clip) {
  const w = canvas.clientWidth || Math.max(1, Math.round(clip.duration * state.ppp));
  const h = canvas.clientHeight || Math.max(1, LANE_H - 22);
  const r = dpr();
  canvas.width = Math.max(1, Math.round(w * r));
  canvas.height = Math.max(1, Math.round(h * r));
  const g = canvas.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);

  const info = state.buffers.get(clip.bufferId);
  const mid = h / 2;
  const half = Math.max(2, h / 2 - 1);
  const entry = clipEls.get(clip.id);
  const color = entry ? entry.track.color : '#38bdf8';

  g.strokeStyle = '#ffffff18';
  g.beginPath(); g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(w, Math.round(mid) + 0.5); g.stroke();

  if (!info) return;
  g.fillStyle = mix(color, '#ffffff', 0.25);
  g.globalAlpha = 0.85;
  for (let x = 0; x < w; x += 1) {
    const t0 = clip.offset + x / state.ppp;
    const t1 = clip.offset + (x + 1) / state.ppp;
    if (t0 >= info.duration) break;
    const [lo, hi] = peakRange(info, t0, Math.min(t1, info.duration));
    const y1 = mid - hi * half;
    const y0 = mid - lo * half;
    g.fillRect(x, y1, 1, Math.max(1, y0 - y1));
  }
  g.globalAlpha = 1;
}

function updateClipDom(clip) {
  const entry = clipEls.get(clip.id);
  if (!entry) { renderAll(); return; }
  entry.root.style.left = Math.round(timeToX(clip.start)) + 'px';
  entry.root.style.width = Math.max(6, Math.round(clip.duration * state.ppp)) + 'px';
  entry.titleEl.querySelector('span').textContent = fmtTime(clip.duration);
  drawWave(entry.canvas, clip);
}

/* ---------------------------------------------------------- drag / trim */
function snapTargets(excludeClipId) {
  const pts = [0, state.playhead];
  for (const t of state.tracks) for (const c of t.clips) {
    if (c.id === excludeClipId) continue;
    pts.push(c.start, c.start + c.duration);
  }
  return pts;
}
/** Nearest legal snap target for a single timeline value (null if none in range). */
function snapPoint(value, excludeClipId) {
  const tol = 9 / state.ppp;
  let best = null;
  for (const target of snapTargets(excludeClipId)) {
    const d = Math.abs(value - target);
    if (d <= tol && (!best || d < best.d)) best = { d, value: target, x: timeToX(target) };
  }
  return best;
}
/** Snap whichever edge (start or end) of a moved box is closest to a target. */
function snapBox(candidateStart, duration, excludeClipId) {
  const a = snapPoint(candidateStart, excludeClipId);
  const b = snapPoint(candidateStart + duration, excludeClipId);
  if (a && b) return a.d <= b.d ? { value: a.value, x: a.x } : { value: b.value - duration, x: b.x };
  if (a) return { value: a.value, x: a.x };
  if (b) return { value: b.value - duration, x: b.x };
  return null;
}

function startClipDrag(e, clip, track, root) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const handle = e.target.dataset ? e.target.dataset.handle : null;
  const mode = handle === 'l' ? 'trim-l' : handle === 'r' ? 'trim-r' : 'move';
  e.stopPropagation();
  e.preventDefault();

  selectClip(clip.id);
  for (const [, entry] of clipEls) entry.root.dataset.sel = entry.clip === clip ? '1' : '';
  renderInspector();

  // measure lane rectangles for vertical (change track) dragging
  const laneRects = [];
  for (const [id, el] of laneEls) {
    const r = el.getBoundingClientRect();
    laneRects.push({ id, top: r.top, bottom: r.bottom });
  }
  drag = {
    clip, mode, startX: e.clientX, startY: e.clientY,
    orig: { start: clip.start, offset: clip.offset, duration: clip.duration },
    currentTrackId: track.id,
    laneRects, moved: false, pointerId: e.pointerId
  };
  try { root.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  root.classList.add('dragging');

  const onMove = ev => {
    if (!drag) return;
    const dx = (ev.clientX - drag.startX) / state.ppp;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && (Math.abs(ev.clientX - drag.startX) > 3 || Math.abs(dy) > 3)) drag.moved = true;
    if (!drag.moved) return;

    if (drag.mode === 'move') {
      // crossing into another lane moves the clip to that track
      const over = drag.laneRects.find(r => ev.clientY >= r.top && ev.clientY <= r.bottom);
      if (over && over.id !== drag.currentTrackId) {
        if (changeTrackOf(clip, over.id)) drag.currentTrackId = over.id;
      }
      let candidate = Math.max(0, drag.orig.start + dx);
      const snap = snapBox(candidate, clip.duration, clip.id);
      if (snap) { candidate = Math.max(0, snap.value); showSnapGuide(snap.x); } else hideSnapGuide();
      clip.start = candidate;
      updateClipDom(clip);
    } else if (drag.mode === 'trim-l') {
      // the left edge moves; the source offset compensates so audio content stays put
      const lo = Math.max(-drag.orig.offset, -drag.orig.start);
      const hi = drag.orig.duration - 0.01;
      let candidate = clamp(drag.orig.start + dx, lo, hi);
      const snap = snapPoint(candidate, clip.id);
      if (snap) candidate = clamp(snap.value, lo, hi);
      if (snap) showSnapGuide(snap.x); else hideSnapGuide();
      const shift = candidate - drag.orig.start;
      setClipGeometry(clip, {
        start: drag.orig.start + shift,
        offset: drag.orig.offset + shift,
        duration: drag.orig.duration - shift
      });
      updateClipDom(clip);
    } else {
      // the right edge moves; length grows/shrinks within the source file
      const info = state.buffers.get(clip.bufferId);
      const maxDur = info ? Math.max(0.01, info.duration - clip.offset) : drag.orig.duration;
      let dur = clamp(drag.orig.duration + dx, 0.01, maxDur);
      const snap = snapPoint(clip.start + dur, clip.id);
      if (snap) {
        const snapped = snap.value - clip.start;
        if (snapped >= 0.01 && (!info || clip.offset + snapped <= info.duration)) {
          dur = snapped;
          showSnapGuide(snap.x);
        }
      } else hideSnapGuide();
      setClipGeometry(clip, { duration: dur });
      updateClipDom(clip);
    }
    syncInspectorValues();
    renderStats();
  };
  const onUp = ev => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    root.classList.remove('dragging');
    hideSnapGuide();
    if (drag && drag.moved) {
      clip.start = round3(clip.start);
      clip.offset = round3(clip.offset);
      clip.duration = round3(clip.duration);
      if (transport.playing) playFrom(state.playhead);
    }
    drag = null;
    renderAll();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
function changeTrackOf(clip, trackId) {
  const from = findClip(clip.id);
  const to = findTrack(trackId);
  if (!from || !to || from.track === to) return false;
  from.track.clips = from.track.clips.filter(c => c !== clip);
  to.clips.push(clip);
  to.clips.sort((a, b) => a.start - b.start);
  const entry = clipEls.get(clip.id);
  if (entry) {
    entry.track = to;
    entry.root.style.setProperty('--c1', mix(to.color, '#16202c', 0.66));
    entry.root.style.setProperty('--c2', mix(to.color, '#0b1017', 0.86));
    entry.root.style.setProperty('--cb', mix(to.color, '#ffffff', 0.05));
    laneEls.get(trackId).appendChild(entry.root);
    drawWave(entry.canvas, clip);
  }
  return true;
}

function showSnapGuide(x) {
  if (!snapGuideEl) {
    snapGuideEl = document.createElement('div');
    snapGuideEl.className = 'snap-guide';
    dom.lanes.appendChild(snapGuideEl);
  }
  snapGuideEl.style.display = 'block';
  snapGuideEl.style.left = (HEADER_W + Math.round(x)) + 'px';
}
function hideSnapGuide() { if (snapGuideEl) snapGuideEl.style.display = 'none'; }

/* --------------------------------------------------------- playhead/zoom */
function ensurePlayheadEl() {
  if (!dom.playhead) {
    dom.playhead = document.createElement('div');
    dom.playhead.className = 'playhead';
    dom.lanes.appendChild(dom.playhead);
  }
  if (!dom.rulerHead && dom.rulerWrap) {
    dom.rulerHead = document.createElement('div');
    dom.rulerHead.className = 'playhead';
    dom.rulerWrap.appendChild(dom.rulerHead);
  }
}
function renderPlayhead() {
  ensurePlayheadEl();
  // .lanes spans the full inner width, so the lane area starts at HEADER_W
  dom.playhead.style.left = (HEADER_W + Math.round(timeToX(state.playhead))) + 'px';
  dom.playhead.style.top = '0px';
  if (dom.rulerHead) dom.rulerHead.style.left = Math.round(timeToX(state.playhead)) + 'px';
  dom.timeCurrent.textContent = fmtTime(state.playhead);
  dom.timeTotal.textContent = fmtTime(projectEnd());
  dom.btnPlay.setAttribute('aria-pressed', transport.playing ? 'true' : 'false');
  dom.btnPlay.innerHTML = transport.playing ? '❚❚ Pause' : '▶ Play';
  // "End at playhead" is meaningless at position 0 — keep it in step with the playhead
  if (dom.projEndHere) dom.projEndHere.disabled = state.playhead <= 0;
}
function setPlayhead(t, opts) {
  state.playhead = clamp(t, 0, Math.max(viewSeconds, projectEnd()));
  renderPlayhead();
  if (opts && opts.inspector !== false) syncInspectorValues();
}

/* -------------------------------------------------------------- end line */
function ensureEndEl() {
  if (!dom.endLine) {
    dom.endLine = document.createElement('div');
    dom.endLine.className = 'end-line';
    dom.lanes.appendChild(dom.endLine);
  }
  if (!dom.endMark && dom.rulerWrap) {
    dom.endMark = document.createElement('div');
    dom.endMark.className = 'end-marker';
    const flag = document.createElement('button');
    flag.type = 'button';
    flag.className = 'end-flag';
    dom.endMark.appendChild(flag);
    dom.rulerWrap.appendChild(dom.endMark);
    wireEndDrag(flag);
  }
}
/** The end line is only drawn when it is explicitly set; auto follows the last clip. */
function renderEnd() {
  ensureEndEl();
  const show = endIsManual() && state.end > 0;
  dom.endLine.hidden = !show;
  dom.endMark.hidden = !show;
  if (!show) return;
  const x = Math.round(timeToX(state.end));
  dom.endLine.style.left = (HEADER_W + x) + 'px';
  dom.endMark.style.left = x + 'px';
  // the value label hangs to the right of the line; when that would fall outside the
  // visible part of the scroll container it would be clipped, so hang it to the left
  const viewRight = dom.scroll ? dom.scroll.getBoundingClientRect().right : Infinity;
  dom.endMark.classList.toggle('flip', laneOriginX() + x + 64 > viewRight);
  const flag = dom.endMark.firstElementChild;
  flag.textContent = '▮ ' + state.end.toFixed(2) + 's';
  flag.title = 'End line ' + state.end.toFixed(2) + ' s — drag to move it, Shift+E to remove';
}
function snapEnd(value) {
  const tol = 9 / state.ppp;
  const targets = [0, state.playhead, computeDuration()];
  for (const t of state.tracks) for (const c of t.clips) targets.push(c.start, c.start + c.duration);
  let best = null;
  for (const target of targets) {
    const d = Math.abs(value - target);
    if (d <= tol && (!best || d < best.d)) best = { d, value: target };
  }
  return best ? best.value : value;
}
function wireEndDrag(flag) {
  flag.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    const wasPlaying = transport.playing;
    if (wasPlaying) pausePlayback();
    let moved = false;
    const move = ev => {
      setProjectEnd(snapEnd(clientXToTime(ev.clientX)));
      renderEnd();
      syncProjectFields();
      renderStats();
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moved) return;
      renderAll();
      if (wasPlaying) playFrom(state.playhead);
      toast('End line at ' + state.end.toFixed(2) + ' s — total length.', 'ok');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
function applyEndLine(t, note) {
  const v = setProjectEnd(t);
  if (!v) { toast('Type a length greater than 0, or use “Follow last clip”.', 'err'); return 0; }
  renderAll();
  scrollToShow(v);
  if (transport.playing) playFrom(Math.min(state.playhead, v));
  toast((note || 'End line') + ' set to ' + v.toFixed(2) + ' s — playback and export stop there.', 'ok');
  return v;
}
function clearEndLine() {
  if (!endIsManual()) { toast('No end line set — the length already follows the last clip.', 'err'); return; }
  clearProjectEnd();
  renderAll();
  if (transport.playing) playFrom(Math.min(state.playhead, projectEnd()));
  toast('End line removed — length follows the last clip.', 'ok');
}
function scrollToShow(time) {
  const x = HEADER_W + timeToX(time);
  const left = dom.scroll.scrollLeft;
  const right = left + dom.scroll.clientWidth;
  if (x < left + HEADER_W + 30) dom.scroll.scrollLeft = Math.max(0, x - HEADER_W - 80);
  else if (x > right - 60) dom.scroll.scrollLeft = x - dom.scroll.clientWidth + 120;
}
function setZoom(ppp, anchorTime) {
  const anchor = anchorTime !== undefined ? anchorTime : (state.playhead || viewSeconds / 2);
  state.ppp = clamp(ppp, 6, 2400);
  renderAll();
  dom.scroll.scrollLeft = Math.max(0, HEADER_W + timeToX(anchor) - dom.scroll.clientWidth * 0.35);
  renderStats();
}
function zoomToFit() {
  const total = projectEnd();
  if (total <= 0) { setZoom(80, 0); return; }
  const avail = Math.max(200, dom.scroll.clientWidth - HEADER_W - 20);
  setZoom(avail / total, 0);
}

/* ------------------------------------------------------------- inspector */
function renderInspector() {
  const clip = selectedClip();
  const track = clip ? null : selectedTrack();
  dom.inspEmpty.hidden = !!(clip || track);
  dom.inspClip.hidden = !clip;
  dom.inspTrack.hidden = !track;
  if (clip) {
    dom.clipName.value = clip.name;
    dom.clipGain.value = clip.gain;
    dom.clipGainOut.textContent = Number(clip.gain).toFixed(2);
    dom.clipFadeIn.value = round3(clip.fadeIn);
    dom.clipFadeOut.value = round3(clip.fadeOut);
    syncInspectorValues();
  } else if (track) {
    dom.trackName.value = track.name;
    dom.trackGain.value = track.gain;
    dom.trackGainOut.textContent = Number(track.gain).toFixed(2);
  }
  dom.btnDelete.disabled = !clip;
  dom.btnSplit.disabled = !clip;
  syncProjectFields();
}
/** Project-level fields: the end line / total length, always visible. */
function syncProjectFields() {
  if (!dom.projEnd) return;
  const manual = endIsManual();
  const content = computeDuration();
  if (document.activeElement !== dom.projEnd) dom.projEnd.value = manual ? state.end.toFixed(2) : '';
  dom.projEnd.placeholder = content.toFixed(2);
  dom.projContent.value = content.toFixed(2);
  dom.projEndState.textContent = manual
    ? 'End line set — the project is exactly ' + state.end.toFixed(2) + ' s. Playback and the WAV export stop there.' +
      (state.end < content - 0.005 ? ' Clips past it are muted in the mix.' : state.end > content + 0.005 ? ' The gap after the last clip stays silent.' : '')
    : 'No end line — the length follows the last clip (' + content.toFixed(2) + ' s). Set one to trim the mix or add a silent tail.';
  dom.projEndState.classList.toggle('is-set', manual);
  dom.projEndClear.disabled = !manual;
  dom.projEndHere.disabled = state.playhead <= 0;
}
function syncInspectorValues() {
  const clip = selectedClip();
  if (!clip) return;
  if (document.activeElement !== dom.clipStart) dom.clipStart.value = round3(clip.start);
  if (document.activeElement !== dom.clipLength) dom.clipLength.value = round3(clip.duration);
  if (document.activeElement !== dom.clipOffset) dom.clipOffset.value = round3(clip.offset);
}
function renderStats() {
  dom.statTracks.textContent = state.tracks.length + (state.tracks.length === 1 ? ' track' : ' tracks');
  dom.statClips.textContent = countClips() + (countClips() === 1 ? ' clip' : ' clips');
  dom.statLength.textContent = fmtTime(projectEnd()) + ' total';
  dom.timeTotal.textContent = fmtTime(projectEnd());
  if (dom.statEnd) {
    const manual = endIsManual();
    dom.statEnd.hidden = !manual;
    if (manual) {
      const diff = state.end - computeDuration();
      dom.statEnd.textContent = '· ▮ end line ' + state.end.toFixed(2) + 's' +
        (Math.abs(diff) < 0.005 ? '' : (diff > 0 ? ' (+' + diff.toFixed(2) + 's tail)' : ' (' + diff.toFixed(2) + 's cut)'));
    }
  }
  // unsaved work means the close/reload guard will ask — say so before it happens
  const dirty = projectIsDirty();
  if (dom.statUnsaved) dom.statUnsaved.hidden = !dirty;
  if (dom.btnSaveProject) dom.btnSaveProject.classList.toggle('needs-save', dirty);
}

/* --------------------------------------------------------------- meter */
function drawMeter() {
  const c = dom.meter;
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  if (!transport.playing) return;
  const lv = meterLevel();
  const norm = v => clamp(Math.pow(Math.max(0, v), 0.6), 0, 1);
  const bar = norm(lv.peak) * (w - 2);
  const rms = norm(lv.rms) * (w - 2);
  g.fillStyle = '#12314a'; g.fillRect(1, 1, w - 2, h - 2);
  g.fillStyle = '#38bdf8'; g.fillRect(1, 1, rms, h - 2);
  g.fillStyle = lv.peak > 0.99 ? '#fb7185' : '#a3e635'; g.fillRect(1 + bar - 1, 1, 2, h - 2);
  g.fillStyle = '#ffffff22'; g.fillRect(1 + (w - 2) * 0.5, 1, 1, h - 2);
}

/* -------------------------------------------------------- transport sync */
function syncTransport(force) {
  renderPlayhead();
  drawMeter();
  if (transport.playing) {
    const x = HEADER_W + timeToX(state.playhead);
    const left = dom.scroll.scrollLeft, right = left + dom.scroll.clientWidth;
    if (x > right - 40 || x < left + HEADER_W) scrollToShow(state.playhead);
  }
  if (force) syncInspectorValues();
}

/* ------------------------------------------------------- toolbar wiring */
function wireToolbar() {
  dom.btnPlay.addEventListener('click', () => { resumeAudio(); togglePlay(); renderPlayhead(); });
  dom.btnStop.addEventListener('click', () => { stopPlayback(); renderAll(); });
  dom.btnToStart.addEventListener('click', () => {
    if (transport.playing) { playFrom(0); } else { setPlayhead(0); }
    dom.scroll.scrollLeft = 0;
  });
  dom.btnSplit.addEventListener('click', () => splitSelectedAtPlayhead());
  dom.btnDelete.addEventListener('click', () => {
    const c = selectedClip();
    if (!c) return;
    removeClip(c.id);
    renderAll();
  });
  dom.masterGain.addEventListener('input', e => { setMasterGain(parseFloat(e.target.value)); renderStats(); });
  dom.btnZoomIn.addEventListener('click', () => setZoom(state.ppp * 1.4, clientXToTime(dom.scroll.scrollLeft + dom.scroll.clientWidth / 2)));
  dom.btnZoomOut.addEventListener('click', () => setZoom(state.ppp / 1.4, clientXToTime(dom.scroll.scrollLeft + dom.scroll.clientWidth / 2)));
  dom.btnZoomFit.addEventListener('click', () => zoomToFit());
  dom.btnAdd.addEventListener('click', () => { delete dom.fileInput.dataset.targetTrack; dom.fileInput.click(); });
  dom.btnAdd2.addEventListener('click', () => { delete dom.fileInput.dataset.targetTrack; dom.fileInput.click(); });
  dom.btnAddTrack.addEventListener('click', () => { addTrack(); renderAll(); });
}

function splitSelectedAtPlayhead() {
  const clip = selectedClip();
  if (!clip) { toast('Select a clip first, then press S to split it at the playhead.', 'err'); return; }
  const parts = splitClipAt(clip.id, state.playhead);
  if (!parts) { toast('The playhead is not inside the selected clip.', 'err'); return; }
  selectClip(parts[1].id);
  renderAll();
  toast('Split into two parts.', 'ok');
}

function wireInspector() {
  const numeric = (el, apply) => {
    el.addEventListener('change', () => {
      const clip = selectedClip(); if (!clip) return;
      apply(clip, parseFloat(el.value));
      updateClipDom(clip); renderStats(); syncInspectorValues();
      if (transport.playing) playFrom(state.playhead);
    });
  };
  dom.clipName.addEventListener('input', () => {
    const clip = selectedClip(); if (!clip) return;
    clip.name = dom.clipName.value;
    const entry = clipEls.get(clip.id);
    if (entry) entry.titleEl.querySelector('b').textContent = clip.name;
    renderStats();
  });
  numeric(dom.clipStart, (clip, v) => setClipGeometry(clip, { start: finite(v, clip.start) }));
  numeric(dom.clipLength, (clip, v) => setClipGeometry(clip, { duration: finite(v, clip.duration) }));
  numeric(dom.clipOffset, (clip, v) => setClipGeometry(clip, { offset: finite(v, clip.offset) }));
  dom.clipGain.addEventListener('input', () => {
    const clip = selectedClip(); if (!clip) return;
    clip.gain = clamp(parseFloat(dom.clipGain.value) || 0, 0, 4);
    dom.clipGainOut.textContent = clip.gain.toFixed(2);
    renderAll();
  });
  numeric(dom.clipFadeIn, (clip, v) => { clip.fadeIn = Math.max(0, finite(v, 0)); setClipGeometry(clip, {}); });
  numeric(dom.clipFadeOut, (clip, v) => { clip.fadeOut = Math.max(0, finite(v, 0)); setClipGeometry(clip, {}); });
  document.querySelectorAll('[data-nudge]').forEach(btn => {
    btn.addEventListener('click', () => {
      const clip = selectedClip(); if (!clip) return;
      const step = Math.abs(parseFloat(dom.clipNudge.value) || 0.05);
      const dir = parseFloat(btn.dataset.nudge) < 0 ? -1 : 1;
      setClipGeometry(clip, { start: Math.max(0, clip.start + dir * step) });
      clip.start = round3(clip.start);
      updateClipDom(clip); syncInspectorValues();
      if (transport.playing) playFrom(state.playhead);
    });
  });
  dom.clipSplitPlayhead.addEventListener('click', splitSelectedAtPlayhead);
  dom.clipQuantize.addEventListener('click', () => {
    const clip = selectedClip(); if (!clip) return;
    setClipGeometry(clip, { start: state.playhead });
    renderAll();
  });
  dom.clipRestore.addEventListener('click', () => {
    const clip = selectedClip(); if (!clip) return;
    restoreClipSource(clip);
    renderAll();
  });
  dom.clipDelete.addEventListener('click', () => { const c = selectedClip(); if (c) { removeClip(c.id); renderAll(); } });

  dom.trackName.addEventListener('input', () => { const t = selectedTrack(); if (t) { t.name = dom.trackName.value; renderAll(); } });
  dom.trackGain.addEventListener('input', () => {
    const t = selectedTrack(); if (!t) return;
    t.gain = clamp(parseFloat(dom.trackGain.value) || 0, 0, 4);
    dom.trackGainOut.textContent = t.gain.toFixed(2);
    renderAll();
  });
  dom.trackUp.addEventListener('click', () => { const t = selectedTrack(); if (t) { moveTrack(t.id, -1); renderAll(); } });
  dom.trackDown.addEventListener('click', () => { const t = selectedTrack(); if (t) { moveTrack(t.id, +1); renderAll(); } });
  dom.trackClear.addEventListener('click', () => { const t = selectedTrack(); if (t) { t.clips.length = 0; renderAll(); } });
  dom.trackDelete.addEventListener('click', () => { const t = selectedTrack(); if (t) { removeTrack(t.id); renderAll(); } });

  /* end line / total length */
  dom.projEnd.addEventListener('change', () => {
    const v = parseFloat(dom.projEnd.value);
    if (!Number.isFinite(v) || v <= 0) { clearEndLine(); return; }
    applyEndLine(v, 'End line');
  });
  dom.projEnd.addEventListener('keydown', e => { if (e.key === 'Enter') dom.projEnd.blur(); });
  dom.projEndHere.addEventListener('click', () => applyEndLine(state.playhead, 'End line at playhead'));
  dom.projEndContent.addEventListener('click', () => applyEndLine(computeDuration(), 'End line at the last clip'));
  dom.projEndClear.addEventListener('click', () => clearEndLine());
}

function wireTimelinePointer() {
  // ruler: click / drag to scrub
  dom.ruler.addEventListener('pointerdown', e => {
    const wasPlaying = transport.playing;
    if (wasPlaying) pausePlayback();
    const seek = ev => setPlayhead(clientXToTime(ev.clientX), { inspector: false });
    seek(e);
    const move = ev => seek(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (wasPlaying) playFrom(state.playhead);
      renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // wheel + ctrl = zoom, shift = horizontal scroll
  dom.scroll.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const anchor = clientXToTime(e.clientX);
      setZoom(state.ppp * (e.deltaY < 0 ? 1.15 : 1 / 1.15), anchor);
    } else if (e.shiftKey) {
      dom.scroll.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

/* --------------------------------------------------------------- keys */
function wireKeys() {
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t && typeof t.matches === 'function' && t.matches('input,textarea,select,[contenteditable]')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const total = projectEnd();
    if (e.code === 'Space') { e.preventDefault(); resumeAudio(); togglePlay(); renderPlayhead(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitSelectedAtPlayhead(); }
    else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      if (e.shiftKey) clearEndLine();
      else applyEndLine(state.playhead, 'End line');
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const c = selectedClip();
      if (c) { e.preventDefault(); removeClip(c.id); renderAll(); }
    }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlayhead(state.playhead - (e.shiftKey ? 1 : 0.05)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlayhead(state.playhead + (e.shiftKey ? 1 : 0.05)); }
    else if (e.key === 'Home') { e.preventDefault(); setPlayhead(0); dom.scroll.scrollLeft = 0; }
    else if (e.key === 'End') { e.preventDefault(); setPlayhead(total); scrollToShow(total); }
    else if (e.key === '+' || e.key === '=') { setZoom(state.ppp * 1.4); }
    else if (e.key === '-' || e.key === '_') { setZoom(state.ppp / 1.4); }
    else if (e.key === '0') { zoomToFit(); }
    else if (e.key === 'Escape') { selectClip(null); renderAll(); }
  });
}

/* ------------------------------------------------------------- gathering */
function gatherDom() {
  const ids = {
    scroll: 'timeline-scroll', inner: 'timeline-inner', ruler: 'ruler', lanes: 'lanes',
    empty: 'empty-state', meter: 'meter',
    btnPlay: 'btn-play', btnStop: 'btn-stop', btnToStart: 'btn-to-start', btnSplit: 'btn-split',
    btnDelete: 'btn-delete', btnAdd: 'btn-add', btnAdd2: 'btn-add-2', btnAddTrack: 'btn-add-track',
    btnZoomIn: 'btn-zoom-in', btnZoomOut: 'btn-zoom-out', btnZoomFit: 'btn-zoom-fit',
    btnSaveProject: 'btn-save-project', btnLoadProject: 'btn-load-project', btnExport: 'btn-export',
    fileInput: 'file-input', projectInput: 'project-input',
    masterGain: 'master-gain', timeCurrent: 'time-current', timeTotal: 'time-total',
    statTracks: 'stat-tracks', statClips: 'stat-clips', statLength: 'stat-length', statEnd: 'stat-end',
    statUnsaved: 'stat-unsaved',
    inspEmpty: 'inspector-empty', inspClip: 'insp-clip', inspTrack: 'insp-track',
    projEnd: 'proj-end', projEndState: 'proj-end-state', projContent: 'proj-content',
    projEndHere: 'proj-end-here', projEndContent: 'proj-end-content', projEndClear: 'proj-end-clear',
    clipName: 'clip-name', clipStart: 'clip-start', clipLength: 'clip-length', clipOffset: 'clip-offset',
    clipGain: 'clip-gain', clipGainOut: 'clip-gain-out', clipFadeIn: 'clip-fade-in', clipFadeOut: 'clip-fade-out',
    clipNudge: 'clip-nudge', clipSplitPlayhead: 'clip-split-playhead', clipQuantize: 'clip-quantize',
    clipRestore: 'clip-restore', clipDelete: 'clip-delete',
    trackName: 'track-name', trackGain: 'track-gain', trackGainOut: 'track-gain-out',
    trackUp: 'track-up', trackDown: 'track-down', trackClear: 'track-clear', trackDelete: 'track-delete',
    dropVeil: 'drop-veil', toasts: 'toasts'
  };
  for (const [k, id] of Object.entries(ids)) {
    dom[k] = $(id);
    if (!dom[k]) console.warn('[audiomix] missing element #' + id);
  }
  dom.rulerWrap = document.querySelector('.ruler-wrap');
}

function initUI() {
  gatherDom();
  syncCssVars();
  wireToolbar();
  wireInspector();
  wireTimelinePointer();
  wireKeys();
  dom.masterGain.value = state.masterGain;
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => renderAll(), 120); });
  renderAll();
}

/* ------------------------------------------------------------ public API */
const UI = {
  init: initUI,
  renderAll,
  syncTransport,
  setPlayhead,
  clientXToTime,
  renderStats,
  /** track id whose lane contains this client point, or null */
  laneAtPoint(clientX, clientY) {
    for (const [id, el] of laneEls) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return id;
    }
    return null;
  },
  setDropTarget(trackId) {
    for (const [, el] of laneEls) el.classList.remove('drop-target');
    if (trackId && laneEls.get(trackId)) laneEls.get(trackId).classList.add('drop-target');
  },
  zoomToFit,
  splitSelectedAtPlayhead,
  applyEndLine,
  clearEndLine,
  renderEnd,
  syncProjectFields
};

function toast(msg, kind) {
  if (!dom.toasts) return;
  while (dom.toasts.children.length > 2) dom.toasts.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  if (kind) el.dataset.kind = kind;
  el.textContent = msg;
  dom.toasts.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}
