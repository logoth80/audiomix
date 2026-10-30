'use strict';
/* ==========================================================================
   app.js — file intake (drag & drop / picker), project save+load, WAV export,
   boot. Runs last: depends on model.js, audio.js and ui.js.
   ========================================================================== */

const AUDIO_EXT = /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|mp4|aac|weba|webm|aif|aiff|caf)$/i;
const AUDIO_RE = /(^|\s|\/)(audio\/|x-sea-)/;

/* --------------------------------------------------------- intake rules */
function isAudioFile(f) {
  if (!f) return false;
  if (f.type && f.type.indexOf('audio/') === 0) return true;
  if (AUDIO_EXT.test(f.name || '')) return true;
  return false;
}
function baseName(name) {
  return String(name || 'audio').replace(AUDIO_EXT, '').slice(0, 48) || 'clip';
}
function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const types = dt.types ? Array.from(dt.types) : [];
  return types.indexOf('Files') >= 0;
}

/**
 * Decode + place files. `targetTrackId` puts everything on that lane;
 * otherwise each file gets its own new track at the playhead.
 */
async function addFiles(fileList, targetTrackId) {
  const files = Array.from(fileList || []).filter(f => f && typeof f.name === 'string');
  if (!files.length) return { added: 0, failed: 0 };

  try { await resumeAudio(); } catch (e) { toast(e.message, 'err'); return { added: 0, failed: files.length }; }

  const wasEmpty = state.tracks.length === 0;
  let added = 0, failed = 0, first = null;

  for (const file of files) {
    if (!isAudioFile(file)) {
      failed += 1;
      toast('Skipped "' + file.name + '" — not a recognised audio file.', 'err');
      continue;
    }
    try {
      const info = await addAudioFile(file);
      let trackId = targetTrackId && findTrack(targetTrackId) ? targetTrackId : null;
      if (!trackId) trackId = addTrack({ name: baseName(file.name) }).id;
      const placed = placeBuffer(trackId, info.id, state.playhead, info.name);
      if (!placed) { failed += 1; continue; }
      if (!first) first = placed;
      added += 1;
    } catch (err) {
      failed += 1;
      console.error(err);
      toast((err && err.message) || 'Could not load that file.', 'err');
    }
  }

  if (first) selectClip(first.clip.id);
  UI.renderAll();

  if (added) {
    if (wasEmpty) UI.zoomToFit();
    scrollToShow(first.clip.start + first.clip.duration);
    const names = added === 1 ? '1 clip' : added + ' clips';
    toast('Added ' + names + ' — press Play, or drag the clip on the timeline.', 'ok');
  }
  return { added, failed };
}

/* --------------------------------------------------------- project save */
function safeStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function humanSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function saveProject() {
  if (!state.tracks.length) { toast('Nothing to save — add audio first.', 'err'); return; }
  const missing = Array.from(state.buffers.values()).filter(b => !b.b64);
  if (missing.length) {
    toast('Some audio has no embedded copy, so it cannot be saved into the project.', 'err');
  }
  const data = serializeProject();
  const text = JSON.stringify(data);
  downloadText(text, 'audiomix-project-' + safeStamp() + '.json');
  markProjectSaved();
  UI.renderStats();
  toast('Project saved (' + humanSize(text.length) + '). Audio is embedded, so you can reopen it later.', 'ok');
}

async function loadProject(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('That file is not readable JSON.', 'err');
    return;
  }
  const problem = validateProject(data);
  if (problem) { toast('Not a valid Audiomix project: ' + problem, 'err'); return; }

  pausePlayback();
  stopNodes();
  state.tracks.length = 0;
  state.buffers.clear();
  state.sel = null;
  state.colorIndex = 0;
  state.playhead = 0;

  let failed = 0;
  for (const b of data.buffers) {
    if (!b.b64) { failed += 1; continue; }
    try {
      await addAudioBase64(b.id, b.name || 'audio', b.b64);
    } catch (e) {
      failed += 1;
      console.error(e);
      toast('Could not decode embedded audio "' + (b.name || b.id) + '".', 'err');
    }
  }

  for (const t of data.tracks) {
    const track = {
      id: t.id || uid('T'),
      name: t.name || ('Track ' + (state.tracks.length + 1)),
      color: t.color || PALETTE[state.tracks.length % PALETTE.length],
      gain: Number.isFinite(t.gain) ? clamp(t.gain, 0, 4) : 1,
      muted: !!t.muted, solo: !!t.solo,
      clips: []
    };
    state.tracks.push(track);
    for (const c of (t.clips || [])) {
      if (!state.buffers.has(c.bufferId)) continue;
      makeClip(track, c.bufferId, {
        name: c.name, start: c.start, offset: c.offset, duration: c.duration,
        gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut
      });
    }
  }
  state.masterGain = Number.isFinite(data.masterGain) ? clamp(data.masterGain, 0, 2) : state.masterGain;
  if (master) master.gain.value = state.masterGain;
  dom.masterGain.value = state.masterGain;
  setProjectEnd(Number.isFinite(data.end) ? data.end : 0);
  markProjectSaved();          // a freshly loaded project is not "unsaved work"

  UI.renderAll();
  UI.zoomToFit();
  const n = countClips();
  toast('Project loaded: ' + state.tracks.length + ' tracks / ' + n + ' clips' +
    (endIsManual() ? ', end line ' + state.end.toFixed(2) + 's' : '') +
    (failed ? ' (' + failed + ' audio file(s) could not be decoded)' : ''), failed ? 'err' : 'ok');
}

/* --------------------------------------------------------------- export */
async function exportWav() {
  if (!computeDuration()) { toast('Nothing to export — add audio to the timeline first.', 'err'); return; }
  dom.btnExport.disabled = true;
  dom.btnExport.textContent = '⏳ Rendering…';
  try {
    const buffer = await renderMix();
    const blob = encodeWav(buffer);
    downloadBlob(blob, 'audiomix-mix-' + safeStamp() + '.wav');
    toast('Exported ' + fmtTime(buffer.duration) + ' WAV (' + humanSize(blob.size) + ') at ' +
      buffer.sampleRate + ' Hz' + (endIsManual() ? ', cut at the end line ' + state.end.toFixed(2) + 's' : '') + '.', 'ok');
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + ((e && e.message) || e), 'err');
  } finally {
    dom.btnExport.disabled = false;
    dom.btnExport.textContent = '⬇ Export WAV';
  }
}

/* ------------------------------------------------------------- drop zone */
function wireDragDrop() {
  let depth = 0;
  const veil = dom.dropVeil;
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    veil.hidden = false;
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    UI.setDropTarget(UI.laneAtPoint(e.clientX, e.clientY));
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) { veil.hidden = true; UI.setDropTarget(null); }
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    const trackId = UI.laneAtPoint(e.clientX, e.clientY);
    UI.setDropTarget(null);
    setPlayhead(clientXToTime(e.clientX));
    addFiles(e.dataTransfer.files, trackId);
  });
  // the veil would otherwise swallow the drop coordinates
  veil.addEventListener('dragover', e => { e.preventDefault(); });
  veil.addEventListener('drop', e => { e.preventDefault(); });
}

/* -------------------------------------------------- close / reload guard */
function wireCloseGuard() {
  // We control whether the browser asks at all — only when there is unsaved work.
  // Chrome, Edge and Firefox then show their own wording ("Changes you made may not be
  // saved"); the custom string is only used by browsers that still honour it.
  window.addEventListener('beforeunload', e => {
    if (!projectIsDirty()) return;
    e.preventDefault();
    e.returnValue = 'You have unsaved work — this mix and its arrangement only exist in this tab. Save the project first.';
    return e.returnValue;
  });
}

/* -------------------------------------------------------------- boot */
function wirePickers() {
  dom.fileInput.addEventListener('change', () => {
    const target = dom.fileInput.dataset.targetTrack || null;
    delete dom.fileInput.dataset.targetTrack;
    addFiles(dom.fileInput.files, target);
    dom.fileInput.value = '';
  });
  dom.projectInput.addEventListener('change', () => {
    const f = dom.projectInput.files && dom.projectInput.files[0];
    if (f) loadProject(f);
    dom.projectInput.value = '';
  });
  dom.btnSaveProject.addEventListener('click', saveProject);
  dom.btnLoadProject.addEventListener('click', () => dom.projectInput.click());
  dom.btnExport.addEventListener('click', exportWav);
}

function boot() {
  try {
    UI.init();
    wirePickers();
    wireDragDrop();
    markProjectSaved(); // an empty tab has nothing to lose
    wireCloseGuard();
  } catch (e) {
    console.error(e);
    toast('Startup error: ' + ((e && e.message) || e), 'err');
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
