'use strict';
/* ==========================================================================
   audio.js — decoding, real-time mixed playback, offline mixdown, WAV export
   ========================================================================== */

let actx = null;      // live AudioContext
let master = null;    // master gain (live)
let meterNode = null; // analyser for the level meter

const transport = {
  playing: false,
  ctxAt: 0,        // AudioContext time that corresponds to startPos
  startPos: 0,
  nodes: [],       // started BufferSources
  raf: 0
};

function ensureAudio() {
  if (actx) return actx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio API is not available in this browser');
  actx = new AC();
  master = actx.createGain();
  master.gain.value = state.masterGain;
  meterNode = actx.createAnalyser();
  meterNode.fftSize = 1024;
  meterNode.smoothingTimeConstant = 0.4;
  master.connect(meterNode);
  master.connect(actx.destination);
  return actx;
}
function resumeAudio() {
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') return ctx.resume();
  return Promise.resolve();
}
function setMasterGain(v) {
  state.masterGain = clamp(v, 0, 2);
  if (master) master.gain.value = state.masterGain;
}

/* ------------------------------------------------------------- decoding */
function decodeAudioData(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = b => { if (!settled) { settled = true; resolve(b); } };
    const bad = e => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error('decode failed')); } };
    try {
      const p = ctx.decodeAudioData(arrayBuffer, ok, bad);
      if (p && typeof p.then === 'function') p.then(ok, bad);
    } catch (e) { bad(e); }
  });
}
function fileToArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

/* Waveform overview: fixed-resolution min/max per sample bucket. */
function computePeaks(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const n = buffer.length;
  const bucket = buffer.duration > 600 ? 512 : (buffer.duration > 120 ? 256 : 128);
  const count = Math.max(1, Math.ceil(n / bucket));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const data = [];
  for (let c = 0; c < ch; c += 1) data.push(buffer.getChannelData(c));
  for (let i = 0; i < count; i += 1) {
    const a = i * bucket;
    const b = Math.min(n, a + bucket);
    let lo = 0, hi = 0;
    for (let s = a; s < b; s += 1) {
      let v = 0;
      for (let c = 0; c < ch; c += 1) v += data[c][s];
      v /= ch;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, bucket };
}

/** Store a decoded file as a reusable buffer record. */
function registerBuffer(id, name, buffer, b64) {
  const pk = computePeaks(buffer);
  const info = {
    id, name, buffer, b64: b64 || null,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    peakMin: pk.min, peakMax: pk.max, bucket: pk.bucket
  };
  state.buffers.set(id, info);
  return info;
}

/** Decode an audio File and register it. */
async function addAudioFile(file) {
  const ctx = ensureAudio();
  const [ab, b64] = await Promise.all([fileToArrayBuffer(file), fileToB64(file)]);
  let buffer;
  try {
    buffer = await decodeAudioData(ctx, ab.slice(0));
  } catch (e) {
    throw new Error('Could not decode "' + file.name + '" — try WAV, MP3, OGG or FLAC');
  }
  return registerBuffer(uid('B'), file.name, buffer, b64);
}

/** Decode from a base64 string (project loading). */
async function addAudioBase64(id, name, b64) {
  const ctx = ensureAudio();
  const buffer = await decodeAudioData(ctx, b64ToArrayBuffer(b64));
  return registerBuffer(id, name, buffer, b64);
}

/* ------------------------------------------------------- mix scheduling */
function buildGraph(ctx, dest, from, when) {
  const started = [];
  // the end line cuts the mix; when it is not set, the last clip defines the end
  const endAt = endIsManual() ? state.end : Infinity;
  for (const track of audibleTracks()) {
    const tg = ctx.createGain();
    tg.gain.value = track.gain;
    tg.connect(dest);
    for (const clip of track.clips) {
      const info = state.buffers.get(clip.bufferId);
      if (!info || !info.buffer) continue;
      const naturalEnd = clip.start + clip.duration;
      const clipEnd = Math.min(naturalEnd, endAt);
      if (clipEnd <= from + 1e-4) continue;
      const at = Math.max(from, clip.start);
      const remain = clipEnd - at;
      if (remain <= 0.002) continue;
      const inOffset = Math.min(clip.offset + (at - clip.start), info.duration);

      const src = ctx.createBufferSource();
      src.buffer = info.buffer;
      const g = ctx.createGain();
      const peak = Math.max(0, clip.gain);
      let fi = Math.max(0, clip.fadeIn), fo = Math.max(0, clip.fadeOut);
      if (clipEnd < naturalEnd - 1e-9) fo = 0; // cut by the end line: hard stop, not a fade
      if (fi + fo > remain) { const k = remain / (fi + fo); fi *= k; fo *= k; }
      const t0 = when + (at - from);
      g.gain.setValueAtTime(fi > 0.001 ? 0.0001 : peak, t0);
      if (fi > 0.001) g.gain.linearRampToValueAtTime(peak, t0 + fi);
      if (fo > 0.001) {
        g.gain.setValueAtTime(peak, t0 + Math.max(fi, remain - fo));
        g.gain.linearRampToValueAtTime(0.0001, t0 + remain);
      }
      src.connect(g);
      g.connect(tg);
      src.start(t0, inOffset, remain);
      started.push(src);
    }
  }
  return started;
}

function stopNodes() {
  for (const n of transport.nodes) {
    try { n.stop(); } catch (e) { /* already stopped */ }
    try { n.disconnect(); } catch (e) { /* ignore */ }
  }
  transport.nodes = [];
}

function playbackPosition() {
  if (!transport.playing || !actx) return state.playhead;
  return Math.max(transport.startPos, transport.startPos + (actx.currentTime - transport.ctxAt));
}

function playFrom(from) {
  const ctx = ensureAudio();
  stopNodes();
  const total = projectEnd();
  const start = clamp(from, 0, Math.max(0, total));
  if (total <= 0) { transport.playing = false; return false; }
  const when = ctx.currentTime + 0.05;
  transport.nodes = buildGraph(ctx, master, start, when);
  transport.playing = true;
  transport.ctxAt = when;
  transport.startPos = start;
  state.playhead = start;
  if (transport.raf) cancelAnimationFrame(transport.raf);
  transport.raf = requestAnimationFrame(onTransportFrame);
  return true;
}
function pausePlayback() {
  if (!transport.playing) return;
  state.playhead = playbackPosition();
  transport.playing = false;
  stopNodes();
  if (transport.raf) cancelAnimationFrame(transport.raf);
  transport.raf = 0;
  onTransportFrame(true);
}
function stopPlayback() {
  transport.playing = false;
  stopNodes();
  if (transport.raf) cancelAnimationFrame(transport.raf);
  transport.raf = 0;
  state.playhead = 0;
  onTransportFrame(true);
}
function togglePlay() {
  if (transport.playing) { pausePlayback(); return false; }
  const total = projectEnd();
  const from = state.playhead >= total - 0.01 ? 0 : state.playhead;
  return playFrom(from);
}

function onTransportFrame(force) {
  const total = projectEnd();
  if (transport.playing) {
    state.playhead = Math.min(playbackPosition(), total);
    if (state.playhead >= total - 0.001) {
      transport.playing = false;
      stopNodes();
      state.playhead = total;
      transport.raf = 0;
    } else {
      transport.raf = requestAnimationFrame(onTransportFrame);
    }
  }
  if (typeof UI !== 'undefined') UI.syncTransport(force);
}

/* ------------------------------------------------------ offline mixdown */
async function renderMix() {
  const total = projectEnd();
  if (total <= 0) return null;
  // an explicit end line means "exactly this long"; otherwise leave a short tail
  const tail = endIsManual() ? 0 : 0.15;
  const sr = ensureAudio().sampleRate;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) throw new Error('OfflineAudioContext is not available in this browser');
  const oc = new OC(2, Math.round((total + tail) * sr), sr);
  const om = oc.createGain();
  om.gain.value = state.masterGain;
  om.connect(oc.destination);
  buildGraph(oc, om, 0, 0);
  return await oc.startRendering();
}

function encodeWav(buffer) {
  const numCh = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const len = buffer.length;
  const bytesPer = 2;
  const dataSize = len * numCh * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * bytesPer, true);
  view.setUint16(32, numCh * bytesPer, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < numCh; c += 1) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      let s = chans[c][i];
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: mime || 'application/json' }), filename);
}

/* ------------------------------------------------------------ metering */
function meterLevel() {
  if (!meterNode) return 0;
  const buf = new Float32Array(meterNode.fftSize);
  if (meterNode.getFloatTimeDomainData) meterNode.getFloatTimeDomainData(buf);
  else {
    const u8 = new Uint8Array(meterNode.fftSize);
    meterNode.getByteTimeDomainData(u8);
    for (let i = 0; i < u8.length; i += 1) buf[i] = (u8[i] - 128) / 128;
  }
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
    sum += v;
  }
  return { peak, rms: sum / buf.length };
}
