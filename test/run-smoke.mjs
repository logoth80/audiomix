/* Headless integration test for Audiomix.
 * Drives the real index.html in Chrome/Edge over the DevTools protocol:
 * synthesises two WAV files, drops them on the timeline, splits, moves,
 * removes, renders the mix offline, checks the WAV bytes, and round-trips
 * a saved project. Run with:  node test/run-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const CANDIDATES = [
  process.env.CHROME || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const PORT = 9337;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { stat } = await import('node:fs/promises');
  let browser = null;
  for (const p of CANDIDATES) {
    try { await stat(p); browser = p; break; } catch { /* try next */ }
  }
  if (!browser) { console.error('NO_BROWSER'); process.exit(2); }

  const profile = path.join(ROOT, 'test', '.chrome-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(browser, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i += 1) {
      try { info = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); }
      catch { await sleep(250); }
    }
    if (!info) throw new Error('browser devtools did not start');

    const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' });
    const target = await created.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    const dialogWaiters = [];
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Page.javascriptDialogOpening' && dialogWaiters.length) dialogWaiters.shift()(msg.params);
    };
    const send = (method, params = {}) => new Promise(res => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    /** Resolve with the params of the next native dialog, or null after `ms`. */
    const waitForDialog = ms => new Promise(res => {
      const done = p => { clearTimeout(timer); const i = dialogWaiters.indexOf(done); if (i >= 0) dialogWaiters.splice(i, 1); res(p); };
      const timer = setTimeout(() => done(null), ms);
      dialogWaiters.push(done);
    });

    await send('Runtime.enable');
    await send('Page.enable');

    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) {
        return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
      }
      return r.result?.result?.value;
    };

    // wait for the app to boot
    let booted = false;
    for (let i = 0; i < 40 && !booted; i += 1) {
      booted = await evaluate('(() => typeof state === "object" && typeof UI === "object" && !!document.getElementById("lanes"))()');
      if (!booted) await sleep(200);
    }

    const results = [];
    const step = async (name, expr) => {
      const value = await evaluate(expr);
      results.push({ name, value });
      console.log(name + ' => ' + JSON.stringify(value));
    };

    await step('boot', '({ tracks: state.tracks.length, lanes: document.querySelectorAll(".lane").length, hasUI: typeof UI === "object" })');

    await step('makeWavs', `(async () => {
      const mk = async (freq, secs) => {
        const sr = 44100;
        const oc = new OfflineAudioContext(2, Math.round(sr * secs), sr);
        const o = oc.createOscillator(); const g = oc.createGain();
        o.frequency.value = freq; g.gain.value = 0.4;
        o.connect(g); g.connect(oc.destination); o.start(0); o.stop(secs);
        const b = await oc.startRendering();
        return new File([encodeWav(b)], 'tone-' + freq + '.wav', { type: 'audio/wav' });
      };
      window.__f1 = await mk(440, 2.0);
      window.__f2 = await mk(660, 1.5);
      return { f1: window.__f1.size, f2: window.__f2.size };
    })()`);

    await step('dropTwoFiles', `(async () => {
      const r = await addFiles([window.__f1, window.__f2], null);
      return { added: r.added, tracks: state.tracks.length, clips: countClips(), total: +computeDuration().toFixed(3), domClips: document.querySelectorAll(".clip").length };
    })()`);

    await step('splitAtPlayhead', `(() => {
      const c = state.tracks[0].clips[0];
      selectClip(c.id);
      setPlayhead(1.0);
      const parts = splitClipAt(c.id, 1.0);
      const t = state.tracks[0];
      return { parts: !!parts, clips: t.clips.length, geo: t.clips.map(x => ({ s:+x.start.toFixed(3), o:+x.offset.toFixed(3), d:+x.duration.toFixed(3) })) };
    })()`);

    await step('removePart', `(() => {
      const t = state.tracks[0];
      removeClip(t.clips[1].id);
      UI.renderAll();
      return { clips: t.clips.length, total: +computeDuration().toFixed(3), domClips: document.querySelectorAll(".clip").length };
    })()`);

    await step('moveClipOnTimeline', `(() => {
      const c = state.tracks[1].clips[0];
      setClipGeometry(c, { start: 0.5 });
      c.start = 0.5;
      UI.renderAll();
      return { start: c.start, total: +computeDuration().toFixed(3) };
    })()`);

    await step('dragHelpers', `(() => {
      window.__drag = (clipId, selector, dx, dy) => {
        const el = document.querySelector('[data-clip-id="' + clipId + '"]');
        if (!el) return { error: 'no clip element' };
        const src = selector ? el.querySelector(selector) : el;
        if (!src) return { error: 'no ' + selector };
        const r = src.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const ev = (type, cx, cy) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, clientX: cx, clientY: cy, button: 0 });
        src.dispatchEvent(ev('pointerdown', x, y));
        window.dispatchEvent(ev('pointermove', x + dx * 0.4, y + dy * 0.4));
        window.dispatchEvent(ev('pointermove', x + dx, y + dy));
        window.dispatchEvent(ev('pointerup', x + dx, y + dy));
        return { ok: true };
      };
      return true;
    })()`);

    await step('dragClipRight', `(() => {
      const c = state.tracks[1].clips[0];
      const before = c.start, ppp = state.ppp;
      window.__drag(c.id, null, 200, 0);
      const expected = before + 200 / ppp;
      const el = document.querySelector('[data-clip-id="' + c.id + '"]');
      return { before:+before.toFixed(3), after:+c.start.toFixed(3), expected:+expected.toFixed(3),
               moved: Math.abs(c.start - expected) < 0.01, domMatchesDom: Math.abs(parseFloat(el.style.left) - c.start * ppp) < 2 };
    })()`);

    await step('dragClipToAnotherTrack', `(() => {
      const c = state.tracks[1].clips[0];
      const lanes = [...document.querySelectorAll('.lane')];
      const own = document.querySelector('[data-clip-id="' + c.id + '"]').closest('.lane').getBoundingClientRect();
      const target = lanes[0].getBoundingClientRect();
      window.__drag(c.id, null, 0, (target.top + target.height / 2) - (own.top + own.height / 2));
      return { onTrack0: state.tracks[0].clips.length, onTrack1: state.tracks[1].clips.length,
               movedDown: state.tracks[1].clips.length === 0 };
    })()`);

    await step('trimLeftEdge', `(() => {
      const c = state.tracks[0].clips[0];
      const before = { s:c.start, d:c.duration, o:c.offset };
      window.__drag(c.id, '.handle.left', 200, 0);
      return { before, after: { s:+c.start.toFixed(3), o:+c.offset.toFixed(3), d:+c.duration.toFixed(3) },
               sourceShifted: c.offset > 0.3, endUnchanged: Math.abs((c.start + c.duration) - (before.s + before.d)) < 0.02 };
    })()`);

    await step('trimRightEdge', `(() => {
      const c = state.tracks[0].clips[0];
      const before = { s:c.start, d:c.duration, o:c.offset };
      window.__drag(c.id, '.handle.right', -400, 0);
      return { before, after: { s:+c.start.toFixed(3), d:+c.duration.toFixed(3), o:+c.offset.toFixed(3) },
               shortened: c.duration < before.d - 0.1, startUntouched: c.start === before.s, offsetUntouched: c.offset === before.o };
    })()`);

    await step('offlineMix', `(async () => {
      const total = computeDuration();
      const b = await renderMix();
      const rms = (from) => { const ch = b.getChannelData(0); let s = 0, n = 0;
        for (let i = Math.floor(from * b.sampleRate); i < Math.min(b.length, Math.floor((from + 0.2) * b.sampleRate)); i++) { s += ch[i] * ch[i]; n++; }
        return +Math.sqrt(s / Math.max(1, n)).toFixed(4); };
      return { projectTotal:+total.toFixed(3), renderDuration:+b.duration.toFixed(3), length:b.length, sr:b.sampleRate,
               lengthMatches: Math.abs(b.duration - (total + 0.15)) < 0.01,
               win0_6: rms(0.6), win1_8: rms(1.8), hasAudio: Math.max(rms(0.1), rms(0.6), rms(1.8)) > 0.01 };
    })()`);

    await step('muteChangesMix', `(async () => {
      const before = await renderMix();
      const beforeRms = (() => { const ch = before.getChannelData(0); let s=0; for (let i=0;i<ch.length;i++) s+=ch[i]*ch[i]; return Math.sqrt(s/ch.length); })();
      state.tracks[0].muted = true;
      const after = await renderMix();
      const afterRms = (() => { const ch = after.getChannelData(0); let s=0; for (let i=0;i<ch.length;i++) s+=ch[i]*ch[i]; return Math.sqrt(s/ch.length); })();
      const soloed = (() => { state.tracks[0].muted = false; state.tracks[1].solo = true; return true; })();
      const solo = await renderMix();
      const soloRms = (() => { const ch = solo.getChannelData(0); let s=0; for (let i=0;i<ch.length;i++) s+=ch[i]*ch[i]; return Math.sqrt(s/ch.length); })();
      state.tracks[1].solo = false;
      return { beforeRms:+beforeRms.toFixed(5), afterRms:+afterRms.toFixed(5), soloRms:+soloRms.toFixed(5), muteReduces: afterRms < beforeRms, soloMatches: Math.abs(soloRms - afterRms) < 1e-4 };
    })()`);

    await step('wavExport', `(async () => {
      const b = await renderMix();
      const blob = encodeWav(b);
      const buf = await blob.arrayBuffer();
      const v = new DataView(buf);
      const str = (o,n) => String.fromCharCode(...new Uint8Array(buf, o, n));
      return { size: blob.size, riff: str(0,4), wave: str(8,4), fmt: str(12,4), data: str(36,4),
               channels: v.getUint16(22,true), bits: v.getUint16(34,true), sr: v.getUint32(24,true),
               expected: 44 + b.length * v.getUint16(22,true) * 2, ok: blob.size === 44 + b.length * v.getUint16(22,true) * 2 };
    })()`);

    await step('realtimePlayback', `(async () => {
      await resumeAudio();
      const started = playFrom(0);
      const t0 = actx.currentTime;
      await new Promise(r => setTimeout(r, 400));
      const t1 = actx.currentTime;
      const pos = playbackPosition();
      const advancing = transport.playing && pos > 0.1;
      pausePlayback();
      return { started, ctxState: actx.state, clockAdvanced:+(t1-t0).toFixed(3), position:+pos.toFixed(3), advancing };
    })()`);

    await step('projectRoundTrip', `(async () => {
      const json = JSON.stringify(serializeProject());
      const before = { tracks: state.tracks.length, clips: countClips(), geo: state.tracks.map(t => t.clips.map(c => [ +c.start.toFixed(3), +c.offset.toFixed(3), +c.duration.toFixed(3) ])), names: state.tracks.map(t=>t.name) };
      const file = new File([json], 'proj.json', { type: 'application/json' });
      await loadProject(file);
      const after = { tracks: state.tracks.length, clips: countClips(), geo: state.tracks.map(t => t.clips.map(c => [ +c.start.toFixed(3), +c.offset.toFixed(3), +c.duration.toFixed(3) ])), names: state.tracks.map(t=>t.name) };
      return { bytes: json.length, before, after, same: JSON.stringify(before) === JSON.stringify(after) };
    })()`);

    await step('splitIsAudiblyIdentical', `(async () => {
      const stat = async () => { const b = await renderMix(); const ch = b.getChannelData(0); return { b, ch }; };
      const a = await stat();
      const all = []; state.tracks.forEach(t => t.clips.forEach(c => all.push(c)));
      const c = all.sort((x, y) => y.duration - x.duration)[0];
      const ok = splitClipAt(c.id, c.start + c.duration / 2);
      const z = await stat();
      let maxDiff = 0, sumDiff = 0, n = Math.min(a.ch.length, z.ch.length);
      for (let i = 0; i < n; i += 1) { const d = Math.abs(a.ch[i] - z.ch[i]); if (d > maxDiff) maxDiff = d; sumDiff += d; }
      return { split: !!ok, sameLength: a.b.length === z.b.length, maxDiff:+maxDiff.toFixed(6), meanDiff:+(sumDiff / n).toFixed(8),
               unchangedBySplit: maxDiff < 0.02, clipCount: countClips() };
    })()`);

    await step('splitViaToolbarButton', `(() => {
      const all = []; state.tracks.forEach(t => t.clips.forEach(c => all.push(c)));
      const c = all.sort((a,b)=>b.duration-a.duration)[0];
      const before = countClips();
      const btn = document.getElementById('btn-split');
      const disabledWithoutSelection = btn.disabled;   // nothing selected yet
      selectClip(c.id); UI.renderAll();               // select the way the UI does
      const enabledAfterSelect = !btn.disabled;
      setPlayhead(c.start + c.duration / 2);
      btn.click();
      return { disabledWithoutSelection, enabledAfterSelect, splitTarget:{s:+c.start.toFixed(3), d:+c.duration.toFixed(3)},
               before, after: countClips(), grew: countClips() === before + 1,
               domClips: document.querySelectorAll('.clip').length,
               parts: state.tracks.map(t=>t.clips.map(x => ({ s:+x.start.toFixed(3), o:+x.offset.toFixed(3), d:+x.duration.toFixed(3) }))) };
    })()`);

    await step('splitFailsOutsideClip', `(() => {
      const all = []; state.tracks.forEach(t => t.clips.forEach(c => all.push(c)));
      const c = all.sort((a,b)=>b.duration-a.duration)[0];
      const before = countClips();
      selectClip(c.id); setPlayhead(c.start + c.duration + 0.5);
      document.getElementById('btn-split').click();
      return { unchanged: countClips() === before };
    })()`);

    await step('reorderTracksWithButtons', `(() => {
      const names = state.tracks.map(t => t.name);
      if (names.length < 2) return { skipped: true };
      document.querySelectorAll('.lane-head')[1].querySelector('[data-act="up"]').click();
      const after = state.tracks.map(t => t.name);
      const swapped = after[0] === names[1] && after[1] === names[0];
      document.querySelectorAll('.lane-head')[0].querySelector('[data-act="down"]').click();
      return { swapped, restored: JSON.stringify(state.tracks.map(t => t.name)) === JSON.stringify(names) };
    })()`);

    await step('removeTrackViaHeaderButton', `(() => {
      const before = state.tracks.length;
      const head = document.querySelectorAll('.lane-head')[before - 1];
      head.querySelector('[data-act="del"]').click();
      return { before, after: state.tracks.length, decreased: state.tracks.length === before - 1 };
    })()`);

    await step('muteSoloUiButtons', `(() => {
      const head = document.querySelectorAll('.lane-head')[0];
      head.querySelector('[data-act="mute"]').click();
      const muted = !!state.tracks[0].muted;
      head.querySelector('[data-act="mute"]').click();
      head.querySelector('[data-act="solo"]').click();
      const soloed = !!state.tracks[0].solo;
      head.querySelector('[data-act="solo"]').click();
      return { muted, soloed, audibleNow: audibleTracks().length };
    })()`);

    await step('keyboardShortcuts', `(async () => {
      const K = (code, key) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key }));
      const p0 = state.playhead;
      K('ArrowRight', 'ArrowRight');
      const nudged = state.playhead > p0;
      K('ArrowLeft', 'ArrowLeft');
      const returned = Math.abs(state.playhead - p0) < 1e-6;
      K('Space', ' ');
      await new Promise(r => setTimeout(r, 200));
      const playingViaKey = transport.playing;
      K('Space', ' ');
      const stoppedViaKey = !transport.playing;
      const all = []; state.tracks.forEach(t => t.clips.forEach(c => all.push(c)));
      const c = all.sort((a, b) => b.duration - a.duration)[0];
      selectClip(c.id); setPlayhead(c.start + c.duration * 0.25);
      const before = countClips();
      K('KeyS', 's');
      const splitViaKey = countClips() === before + 1;
      const mid = countClips();
      K('Delete', 'Delete');
      const deletedViaKey = countClips() === mid - 1;
      return { nudged, returned, playingViaKey, stoppedViaKey, splitViaKey, deletedViaKey };
    })()`);
    await step('playButtonToggles', `(async () => {
      await resumeAudio();
      document.getElementById('btn-play').click();
      const playingAfterClick = transport.playing;
      const label1 = document.getElementById('btn-play').textContent.trim();
      await new Promise(r => setTimeout(r, 250));
      const pos = playbackPosition();
      document.getElementById('btn-play').click();
      const pausedAfterSecondClick = !transport.playing;
      const label2 = document.getElementById('btn-play').textContent.trim();
      return { playingAfterClick, pausedAfterSecondClick, position:+pos.toFixed(3), advances: pos > 0.05, label1, label2 };
    })()`);

    await step('stopButtonResetsPlayhead', `(() => {
      setPlayhead(0.7);
      document.getElementById('btn-stop').click();
      return { playhead: state.playhead, zeroed: state.playhead === 0 };
    })()`);

    await step('endLinePrecision', `(() => {
      const a = setProjectEnd(3.146);          // 0.01 s steps
      const b = setProjectEnd(3.004);
      const d = setProjectEnd(0.001);          // never below one step
      const rounds = (a === 3.15 && b === 3 && d === 0.01);
      setProjectEnd(-5);                       // non-positive means "auto"
      return { a, b, d, end: state.end, manual: endIsManual(), roundsTo2dp: rounds,
               autoAfterZero: (!endIsManual() && projectEnd() === computeDuration()) };
    })()`);

    await step('endLineTrimsExport', `(async () => {
      const content = computeDuration();
      setProjectEnd(1.2);
      const cut = await renderMix();
      clearProjectEnd();
      const full = await renderMix();
      let maxDiff = 0;
      const n = Math.min(cut.length, Math.floor(1.0 * cut.sampleRate));
      const a = cut.getChannelData(0), z = full.getChannelData(0);
      for (let i = 0; i < n; i += 1) { const d = Math.abs(a[i] - z[i]); if (d > maxDiff) maxDiff = d; }
      return { content:+content.toFixed(3), duration:+cut.duration.toFixed(5), exact: Math.abs(cut.duration - 1.2) < 0.0005,
               shorterThanFull: cut.length < full.length, headIdentical: maxDiff < 1e-6, maxDiff:+maxDiff.toExponential(2) };
    })()`);

    await step('endLineSilentTail', `(async () => {
      const content = computeDuration();
      const target = Math.round((content + 1.0) * 100) / 100;
      setProjectEnd(target);
      const b = await renderMix();
      const ch = b.getChannelData(0);
      let tailMax = 0;
      for (let i = Math.floor((content + 0.1) * b.sampleRate); i < b.length; i += 1) tailMax = Math.max(tailMax, Math.abs(ch[i]));
      const out = { content:+content.toFixed(3), target, duration:+b.duration.toFixed(5),
                    exact: Math.abs(b.duration - target) < 0.0005, tailMax:+tailMax.toFixed(7), tailSilent: tailMax < 1e-6 };
      clearProjectEnd();
      return out;
    })()`);

    await step('playbackStopsAtEndLine', `(async () => {
      await resumeAudio();
      setProjectEnd(0.6);
      playFrom(0);
      await new Promise(r => setTimeout(r, 900));
      const out = { playhead:+state.playhead.toFixed(3), stoppedAtEnd: (!transport.playing && Math.abs(state.playhead - 0.6) < 0.05) };
      stopPlayback();
      clearProjectEnd();
      return out;
    })()`);

    await step('endLineViaUiAndKeys', `(() => {
      const out = {};
      const input = document.getElementById('proj-end');
      input.value = '1.375';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      out.appliedFromInput = state.end;
      setPlayhead(2);
      document.getElementById('proj-end-here').click();
      out.appliedFromButton = state.end;
      out.lineVisibleWhenSet = !document.querySelector('.end-line').hidden && !document.querySelector('.end-marker').hidden;
      out.flagText = document.querySelector('.end-marker .end-flag').textContent;
      out.badgeText = document.getElementById('stat-end').textContent;
      setPlayhead(2.75);
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyE', key: 'e' }));
      out.appliedFromKey = state.end;
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyE', key: 'E', shiftKey: true }));
      out.clearedByShiftE = !endIsManual();
      out.autoMatchesContent = Math.abs(projectEnd() - computeDuration()) < 1e-9;
      out.lineHiddenWhenAuto = document.querySelector('.end-line').hidden && document.querySelector('.end-marker').hidden;
      return out;
    })()`);

    await step('endLineDragOnRuler', `(() => {
      setProjectEnd(2);
      UI.zoomToFit();
      UI.renderAll();
      const mark = document.querySelector('.end-marker');
      const flippedAtRightEdge = mark.classList.contains('flip');   // label hangs left, stays readable
      const flag = mark.querySelector('.end-flag');
      const ppp = state.ppp;
      const r = flag.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 11, clientX: x, clientY: y, button: 0 });
      flag.dispatchEvent(ev('pointerdown', r.left + r.width / 2));
      window.dispatchEvent(ev('pointermove', r.left + r.width / 2 + 150));
      window.dispatchEvent(ev('pointerup', r.left + r.width / 2 + 150));
      const out = { before: 2, after: state.end, ppp: Math.round(ppp), flippedAtRightEdge,
                    movedRight: state.end > 2 + 100 / ppp,
                    domMatches: Math.abs(parseFloat(document.querySelector('.end-line').style.left) - (208 + state.end * ppp)) < 2,
                    labelInsideViewport: r.right <= document.getElementById('timeline-scroll').getBoundingClientRect().right + 1,
                    flagText: flag.textContent, badge: document.getElementById('stat-end').textContent };
      clearProjectEnd();
      UI.renderAll();
      return out;
    })()`);

    await step('endLineRoundTrip', `(async () => {
      setProjectEnd(1.85);
      const json = JSON.stringify(serializeProject());
      const serialized = JSON.parse(json).end;
      clearProjectEnd();
      await loadProject(new File([json], 'p.json', { type: 'application/json' }));
      const restored = state.end;
      clearProjectEnd();
      UI.renderAll();
      return { serialized, restored, matches: restored === 1.85,
               invalidRejected: validateProject({ app: 'audiomix', tracks: [], buffers: [], end: -3 }) };
    })()`);

    await step('closeGuard', `(() => {
      markProjectSaved();
      const cleanAfterMark = !projectIsDirty();
      const clip = state.tracks[0].clips.find(c => c.duration > 0.05) || state.tracks[0].clips[0];
      const was = clip.start;
      setClipGeometry(clip, { start: was + 0.25 });
      UI.renderAll();
      const dirtyAfterChange = projectIsDirty();
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      const badgeShown = !document.getElementById('stat-unsaved').hidden;
      const saveMarked = document.getElementById('btn-save-project').classList.contains('needs-save');
      markProjectSaved();
      UI.renderStats();
      const cleanAfterSave = !projectIsDirty();
      const ev2 = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev2);
      const badgeHidden = document.getElementById('stat-unsaved').hidden &&
        !document.getElementById('btn-save-project').classList.contains('needs-save');
      setClipGeometry(clip, { start: was });
      markProjectSaved();
      UI.renderAll();
      return { cleanAfterMark, returnValueType: typeof ev.returnValue,
               askedToConfirm: ev.defaultPrevented, dirtyAfterChange, badgeShown, saveMarked,
               cleanAfterSave, quietAfterSave: !ev2.defaultPrevented, badgeHidden };
    })()`);

    await step('dropOntoExistingLane', `(async () => {
      const lane = document.querySelector('.lane');
      const r = lane.getBoundingClientRect();
      const before = { tracks: state.tracks.length, clips: countClips() };
      const target = laneAtPointForTest(r.left + 40, r.top + r.height / 2);
      await addFiles([window.__f2], target);
      return { before, afterTracks: state.tracks.length, afterClips: countClips(),
               placedOnSameLane: state.tracks.length === before.tracks, offsetPastExisting: state.tracks[0].clips.map(c => +c.start.toFixed(2)) };
      function laneAtPointForTest(x, y) { return UI.laneAtPoint(x, y); }
    })()`);

    await step('deleteUiButton', `(() => {
      const n = countClips();
      document.getElementById('btn-delete').click();
      return { before:n, after:countClips(), decreased: countClips() < n };
    })()`);

    await step('emptyAfterDeleteAll', `(() => {
      for (const t of [...state.tracks]) removeTrack(t.id);
      UI.renderAll();
      return { tracks: state.tracks.length, emptyShown: !document.getElementById('empty-state').hidden };
    })()`);

    await step('zoomAndScroll', `(() => {
      const before = state.ppp;
      document.getElementById('btn-zoom-in').click();
      document.getElementById('btn-zoom-fit').click();
      return { before, after: state.ppp, fits: state.ppp < before };
    })()`);

    console.log('CONSOLE_ISSUES ' + JSON.stringify(consoleErrors.slice(0, 12)));
    console.log('BOOTED ' + booted);

    // End-to-end probe of the real close/reload prompt. The dialog itself belongs to the
    // browser — the gate above is our preventDefault — so this is reported, not asserted.
    const dialogProbe = { dirty: false, dialogSeen: false, type: null, answered: false, cameBackClean: false };
    try {
      dialogProbe.dirty = await evaluate(`(async () => {
        await addFiles([window.__f2], null);
        return projectIsDirty();
      })()`);
      const waiting = waitForDialog(5000);
      send('Page.reload');                        // not awaited: it blocks on the dialog
      const dlg = await waiting;
      if (dlg) {
        dialogProbe.dialogSeen = true;
        dialogProbe.type = dlg.type;
        await send('Page.handleJavaScriptDialog', { accept: true });
        dialogProbe.answered = true;
      }
      for (let i = 0; i < 30 && !dialogProbe.cameBackClean; i += 1) {
        await sleep(400);   // the reload is only done once the dialog is answered
        dialogProbe.cameBackClean = !!(await evaluate(
          '(() => typeof state === "object" && state.tracks.length === 0 && !projectIsDirty())()'));
      }
    } catch (e) { dialogProbe.error = String((e && e.message) || e); }
    console.log('CLOSE_DIALOG_PROBE ' + JSON.stringify(dialogProbe));

    const r = Object.fromEntries(results.map(x => [x.name, x.value || {}]));
    const checks = [
      ['app boots without console errors', booted && consoleErrors.length === 0],
      ['drag & drop adds one track per file', r.dropTwoFiles.added === 2 && r.dropTwoFiles.tracks === 2 && r.dropTwoFiles.clips === 2],
      ['dropped files render as clips', r.dropTwoFiles.domClips === 2],
      ['split at playhead produces two correct parts', r.splitAtPlayhead.parts && JSON.stringify(r.splitAtPlayhead.geo) === JSON.stringify([{s:0,o:0,d:1},{s:1,o:1,d:1}])],
      ['removing a part shortens the project', r.removePart.clips === 1 && r.removePart.total === 1.5],
      ['dragging a clip moves it on the timeline', r.dragClipRight.moved && r.dragClipRight.domMatchesDom],
      ['dragging a clip onto another lane re-tracks it', r.dragClipToAnotherTrack.movedDown],
      ['left trim shifts the source offset, keeps the tail', r.trimLeftEdge.sourceShifted && r.trimLeftEdge.endUnchanged],
      ['right trim shortens the clip only', r.trimRightEdge.shortened && r.trimRightEdge.startUntouched && r.trimRightEdge.offsetUntouched],
      ['splitting does not change what you hear', r.splitIsAudiblyIdentical.unchangedBySplit && r.splitIsAudiblyIdentical.sameLength],
      ['split button works, and refuses cuts outside the clip', r.splitViaToolbarButton.disabledWithoutSelection && r.splitViaToolbarButton.enabledAfterSelect && r.splitViaToolbarButton.grew && r.splitViaToolbarButton.domClips === r.splitViaToolbarButton.after && r.splitFailsOutsideClip.unchanged],
      ['offline mix length matches the project', r.offlineMix.lengthMatches && r.offlineMix.hasAudio],
      ['mute/solo change the mix', r.muteChangesMix.muteReduces && r.muteChangesMix.soloMatches],
      ['export is a valid 16-bit stereo WAV', r.wavExport.ok && r.wavExport.riff === 'RIFF' && r.wavExport.wave === 'WAVE' && r.wavExport.data === 'data' && r.wavExport.channels === 2 && r.wavExport.bits === 16],
      ['playback runs on the Web Audio clock', r.realtimePlayback.advancing && r.realtimePlayback.ctxState === 'running'],
      ['Play/Pause button toggles transport', r.playButtonToggles.playingAfterClick && r.playButtonToggles.pausedAfterSecondClick && r.playButtonToggles.advances],
      ['Stop resets the playhead', r.stopButtonResetsPlayhead.zeroed],
      ['dropping onto a lane reuses that lane', r.dropOntoExistingLane.placedOnSameLane && r.dropOntoExistingLane.afterClips === r.dropOntoExistingLane.before.clips + 1],
      ['Delete button removes the selected clip', r.deleteUiButton.decreased],
      ['header button removes a track', r.removeTrackViaHeaderButton.decreased],
      ['track order buttons move a lane', r.reorderTracksWithButtons.swapped && r.reorderTracksWithButtons.restored],
      ['keyboard: play, split, delete, seek', r.keyboardShortcuts.playingViaKey && r.keyboardShortcuts.stoppedViaKey && r.keyboardShortcuts.splitViaKey && r.keyboardShortcuts.deletedViaKey && r.keyboardShortcuts.nudged && r.keyboardShortcuts.returned],
      ['mute/solo buttons update track state', r.muteSoloUiButtons.muted && r.muteSoloUiButtons.soloed],
      ['project save + load round-trips exactly', r.projectRoundTrip.same],
      ['end line stores 0.01 s precision (0 = follow content)', r.endLinePrecision.roundsTo2dp && r.endLinePrecision.autoAfterZero && r.endLinePrecision.manual === false],
      ['end line cuts the mix to an exact length', r.endLineTrimsExport.exact && r.endLineTrimsExport.shorterThanFull && r.endLineTrimsExport.headIdentical],
      ['end line past the last clip adds a silent tail', r.endLineSilentTail.exact && r.endLineSilentTail.tailSilent],
      ['playback stops at the end line', r.playbackStopsAtEndLine.stoppedAtEnd],
      ['end line via field / button / key E, and hides when cleared', r.endLineViaUiAndKeys.appliedFromInput === 1.38 && r.endLineViaUiAndKeys.appliedFromButton === 2 && r.endLineViaUiAndKeys.appliedFromKey === 2.75 && r.endLineViaUiAndKeys.clearedByShiftE && r.endLineViaUiAndKeys.autoMatchesContent && r.endLineViaUiAndKeys.lineVisibleWhenSet && r.endLineViaUiAndKeys.lineHiddenWhenAuto && r.endLineViaUiAndKeys.flagText.includes('2.00') && r.endLineViaUiAndKeys.badgeText.includes('end line 2.00s')],
      ['end line drags on the ruler and matches the DOM', r.endLineDragOnRuler.movedRight && r.endLineDragOnRuler.domMatches && r.endLineDragOnRuler.flippedAtRightEdge && r.endLineDragOnRuler.labelInsideViewport],
      ['end line is saved with the project and validated', r.endLineRoundTrip.serialized === 1.85 && r.endLineRoundTrip.matches && !!r.endLineRoundTrip.invalidRejected],
      ['closing the page asks for confirmation only with unsaved work', r.closeGuard.cleanAfterMark && r.closeGuard.dirtyAfterChange && r.closeGuard.askedToConfirm && r.closeGuard.badgeShown && r.closeGuard.saveMarked && r.closeGuard.cleanAfterSave && r.closeGuard.quietAfterSave && r.closeGuard.badgeHidden],
      ['empty state returns when everything is removed', r.emptyAfterDeleteAll.emptyShown],
      ['zoom in / fit work', r.zoomAndScroll.fits]
    ];
    let failed = 0;
    for (const [name, pass] of checks) {
      if (!pass) failed += 1;
      console.log((pass ? 'PASS  ' : 'FAIL  ') + name);
    }
    console.log('RESULT ' + (checks.length - failed) + '/' + checks.length + ' checks passed');
    if (failed) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    proc.kill();
    // Chrome may still hold the profile for a moment; cleanup is best-effort
    for (let i = 0; i < 8; i += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch { await sleep(400); }
    }
  }
}
main().catch(e => { console.error('TEST_ERROR ' + (e && e.stack || e)); process.exit(1); });
