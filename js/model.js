'use strict';
/* ==========================================================================
   model.js — project data model: tracks, clips, selection, split, (de)serialize
   Pure data + helpers. No DOM, no audio. The UI layer mutates this and re-renders.
   ========================================================================== */

/* Layout constants are the single source of truth; ui.js pushes them into CSS vars. */
const HEADER_W = 208;
const LANE_H = 92;
const LANE_GAP = 6;
const RULER_H = 30;
const PALETTE = [
  '#38bdf8', '#f472b6', '#a3e635', '#fbbf24',
  '#a78bfa', '#fb7185', '#34d399', '#f97316'
];

const state = {
  buffers: new Map(), // id -> { id, name, buffer, b64, peakMin, peakMax, bucket, duration, sampleRate }
  tracks: [],         // { id, name, color, gain, muted, solo, clips: [clip] }
  sel: null,          // { type:'clip', id } | { type:'track', id }
  playhead: 0,
  end: 0,             // end line in seconds, 0.01 s steps; 0 = auto (follow the last clip)
  ppp: 80,            // pixels per second
  masterGain: 0.9,
  colorIndex: 0
};

/* ------------------------------------------------------------------ utils */
let _seq = 0;
function uid(prefix) {
  _seq += 1;
  return prefix + _seq.toString(36) + Math.random().toString(36).slice(2, 6);
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function fmtTime(sec) {
  sec = Math.max(0, finite(sec, 0));
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return m + ':' + String(s).padStart(2, '0') + '.' + d;
}
function round3(v) { return Math.round(v * 1000) / 1000; }
function round2(v) { return Math.round(v * 100) / 100; }

/* --------------------------------------------------------------- queries */
function computeDuration() {
  let end = 0;
  for (const t of state.tracks) {
    for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  }
  return end;
}
/**
 * The end line — where playback and the export stop.
 * state.end === 0 means "auto": follow the last clip. Otherwise the length is
 * exactly what the user typed, in 0.01 s steps, so a set end line is also a
 * total-length control (shorter trims the mix, longer adds a silent tail).
 */
function endIsManual() { return state.end > 0; }
function projectEnd() { return state.end > 0 ? state.end : computeDuration(); }
/** @returns the stored value, rounded to 0.01 s; 0 means back to auto. */
function setProjectEnd(t) {
  if (!Number.isFinite(t) || t <= 0) { state.end = 0; return 0; }
  state.end = Math.max(0.01, round2(t));
  return state.end;
}
function clearProjectEnd() { state.end = 0; return 0; }
function eachClip(fn) {
  for (const t of state.tracks) for (const c of t.clips) {
    const r = fn(c, t);
    if (r) return r;
  }
  return null;
}
function countClips() {
  let n = 0;
  for (const t of state.tracks) n += t.clips.length;
  return n;
}
function findClip(id) {
  if (!id) return null;
  for (const t of state.tracks) {
    const c = t.clips.find(x => x.id === id);
    if (c) return { clip: c, track: t };
  }
  return null;
}
function findTrack(id) { return state.tracks.find(t => t.id === id) || null; }
function selectedClip() {
  if (!state.sel || state.sel.type !== 'clip') return null;
  const hit = findClip(state.sel.id);
  return hit ? hit.clip : null;
}
function selectedTrack() {
  if (!state.sel) return null;
  if (state.sel.type === 'track') return findTrack(state.sel.id);
  const hit = findClip(state.sel.id);
  return hit ? hit.track : null;
}
function selectClip(id) { state.sel = id ? { type: 'clip', id } : null; }
function selectTrack(id) { state.sel = id ? { type: 'track', id } : null; }

/** Tracks that actually produce sound right now (honours mute/solo). */
function audibleTracks() {
  const anySolo = state.tracks.some(t => t.solo);
  return state.tracks.filter(t => {
    if (t.muted) return false;
    if (anySolo) return !!t.solo;
    return true;
  });
}

/* ------------------------------------------------------------- mutations */
function nextColor() {
  const c = PALETTE[state.colorIndex % PALETTE.length];
  state.colorIndex += 1;
  return c;
}
function addTrack(opts) {
  opts = opts || {};
  const t = {
    id: uid('T'),
    name: opts.name || ('Track ' + (state.tracks.length + 1)),
    color: opts.color || nextColor(),
    gain: 1, muted: false, solo: false,
    clips: []
  };
  state.tracks.push(t);
  return t;
}
function removeTrack(id) {
  const i = state.tracks.findIndex(t => t.id === id);
  if (i < 0) return null;
  const [t] = state.tracks.splice(i, 1);
  if (state.sel && (state.sel.type === 'track' && state.sel.id === id)) state.sel = null;
  if (state.sel && state.sel.type === 'clip' && !findClip(state.sel.id)) state.sel = null;
  return t;
}
function moveTrack(id, dir) {
  const i = state.tracks.findIndex(t => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.tracks.length) return false;
  const [t] = state.tracks.splice(i, 1);
  state.tracks.splice(j, 0, t);
  return true;
}
function makeClip(track, bufferId, opts) {
  opts = opts || {};
  const info = state.buffers.get(bufferId);
  const srcDur = info ? info.duration : 0;
  const offset = clamp(finite(opts.offset, 0), 0, Math.max(0, srcDur));
  const duration = clamp(finite(opts.duration, Math.max(0, srcDur - offset)), 0.01, Math.max(0.01, srcDur - offset) || 0.01);
  const clip = {
    id: uid('C'),
    bufferId,
    name: opts.name || (info ? info.name : 'clip'),
    start: Math.max(0, finite(opts.start, 0)),
    offset,
    duration,
    gain: clamp(finite(opts.gain, 1), 0, 4),
    fadeIn: Math.max(0, finite(opts.fadeIn, 0)),
    fadeOut: Math.max(0, finite(opts.fadeOut, 0))
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  return clip;
}
/** Add a clip of `bufferId` to a lane at `start`, avoiding overlap on that lane. */
function placeBuffer(trackId, bufferId, start, name) {
  const track = findTrack(trackId) || addTrack();
  const info = state.buffers.get(bufferId);
  if (!info) return null;
  const dur = info.duration;
  let s = Math.max(0, finite(start, 0));
  // push past any clip already occupying that spot on this lane
  for (let guard = 0; guard < 64; guard++) {
    const clash = track.clips.find(c => c.start < s + dur - 1e-4 && c.start + c.duration > s + 1e-4);
    if (!clash) break;
    s = clash.start + clash.duration;
  }
  const clip = makeClip(track, bufferId, { start: s, duration: dur, name: name || info.name });
  return { clip, track };
}
function removeClip(id) {
  const hit = findClip(id);
  if (!hit) return null;
  const i = hit.track.clips.findIndex(c => c.id === id);
  const [c] = hit.track.clips.splice(i, 1);
  if (state.sel && state.sel.type === 'clip' && state.sel.id === id) state.sel = null;
  return c;
}

/** Split `clipId` at absolute timeline time. Returns the two clips or null. */
function splitClipAt(clipId, time) {
  const hit = findClip(clipId);
  if (!hit) return null;
  const clip = hit.clip;
  const t = time;
  if (t <= clip.start + 0.005 || t >= clip.start + clip.duration - 0.005) return null;

  const cut = t - clip.start;
  const rightDur = clip.duration - cut;
  const right = {
    ...clip,
    id: uid('C'),
    start: t,
    offset: clip.offset + cut,
    duration: rightDur,
    fadeIn: 0,                 // no dip at the cut: interior fades are dropped
    fadeOut: clip.fadeOut,     // the tail fade follows the right half
    name: clip.name
  };
  right.fadeOut = Math.min(right.fadeOut, rightDur);

  const left = clip;
  left.duration = cut;
  left.fadeIn = Math.min(left.fadeIn, cut);
  left.fadeOut = 0;
  hit.track.clips.push(right);
  hit.track.clips.sort((a, b) => a.start - b.start);
  return [clip, right];
}

/** Set geometry with clamping to the source buffer. */
function setClipGeometry(clip, patch) {
  const info = state.buffers.get(clip.bufferId);
  const srcDur = info ? info.duration : clip.duration;
  if (patch.start !== undefined) clip.start = Math.max(0, finite(patch.start, clip.start));
  if (patch.offset !== undefined) clip.offset = clamp(finite(patch.offset, clip.offset), 0, srcDur);
  if (patch.duration !== undefined) {
    const maxDur = Math.max(0.01, srcDur - clip.offset);
    clip.duration = clamp(finite(patch.duration, clip.duration), 0.01, maxDur);
  }
  clip.fadeIn = clamp(clip.fadeIn, 0, clip.duration);
  clip.fadeOut = clamp(clip.fadeOut, 0, clip.duration);
  // re-derive end from current start/length so the caller may set either edge
  return clip;
}
/** Restore the clip to the whole source file (undo every trim). */
function restoreClipSource(clip) {
  const info = state.buffers.get(clip.bufferId);
  if (!info) return clip;
  clip.offset = 0;
  clip.duration = info.duration;
  return clip;
}

/* --------------------------------------------------------- persistence */
function serializeProject() {
  const buffers = [];
  for (const b of state.buffers.values()) {
    buffers.push({ id: b.id, name: b.name, b64: b.b64 || null });
  }
  return {
    app: 'audiomix',
    version: 1,
    masterGain: state.masterGain,
    end: round2(state.end),
    ppp: state.ppp,
    buffers,
    tracks: state.tracks.map(t => ({
      id: t.id, name: t.name, color: t.color, gain: t.gain, muted: t.muted, solo: t.solo,
      clips: t.clips.map(c => ({
        id: c.id, bufferId: c.bufferId, name: c.name, start: round3(c.start),
        offset: round3(c.offset), duration: round3(c.duration), gain: c.gain,
        fadeIn: round3(c.fadeIn), fadeOut: round3(c.fadeOut)
      }))
    }))
  };
}
/** Structural validation used before applying project data. */
function validateProject(data) {
  if (!data || typeof data !== 'object') return 'not an object';
  if (data.app !== 'audiomix') return 'not an Audiomix project file';
  if (!Array.isArray(data.tracks)) return 'missing tracks';
  if (!Array.isArray(data.buffers)) return 'missing buffers';
  if (data.buffers.some(b => !b.id)) return 'buffer entry without id';
  if (data.end !== undefined && (!Number.isFinite(data.end) || data.end < 0)) return 'end line is not a positive number';
  const ids = new Set(data.buffers.map(b => b.id));
  for (const t of data.tracks) {
    if (!Array.isArray(t.clips)) return 'track without clips';
    for (const c of t.clips) {
      if (!ids.has(c.bufferId)) return 'clip references unknown audio "' + c.bufferId + '"';
    }
  }
  return null;
}

/* ------------------------------------------------------------ dirtiness */
/**
 * A cheap fingerprint of everything the user would lose by closing the tab — the mix
 * layout, not the audio bytes — so the same question can be asked by the
 * close-confirmation handler, the status bar and the tests.
 */
function projectSignature() {
  return JSON.stringify({
    g: state.masterGain,
    e: state.end,
    b: Array.from(state.buffers.keys()).sort(),
    t: state.tracks.map(t => [
      t.name, t.color, t.gain, t.muted ? 1 : 0, t.solo ? 1 : 0,
      t.clips.map(c => [c.bufferId, c.name, round3(c.start), round3(c.offset), round3(c.duration),
        c.gain, round3(c.fadeIn), round3(c.fadeOut)])
    ])
  });
}
let savedSignature = null;
/** Call when the project has just been written out or read in (or at boot). */
function markProjectSaved() { savedSignature = projectSignature(); }
/** True when closing or reloading the page would throw away work. */
function projectIsDirty() {
  if (!countClips()) return false; // no mix on the timeline: nothing to lose
  return projectSignature() !== savedSignature;
}
