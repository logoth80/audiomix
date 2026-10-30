/* Renders the real app with demo audio and saves screenshots for visual review.
 * Usage: node test/screenshot.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test', 'shots'));
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const BROWSER = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const profile = path.join(ROOT, 'test', '.chrome-profile-shots');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const proc = spawn(BROWSER, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio',
    '--remote-debugging-port=' + PORT, '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i += 1) {
      try { info = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    const target = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0; const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 2, mobile: false });

    for (let i = 0; i < 40; i += 1) {
      if (await evaluate('typeof state === "object" && typeof UI === "object"')) break;
      await sleep(200);
    }

    const made = await evaluate(`(async () => {
      const sr = 44100;
      const files = [];
      // drum loop: 8 short pitch-dropped kicks
      files.push(await (async () => {
        const secs = 4.0;
        const oc = new OfflineAudioContext(2, Math.round(sr * secs), sr);
        for (let i = 0; i < 8; i += 1) {
          const t = i * 0.5;
          const o = oc.createOscillator(), g = oc.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(180, t);
          o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
          g.gain.setValueAtTime(0.9, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
          o.connect(g); g.connect(oc.destination); o.start(t); o.stop(t + 0.32);
        }
        const b = await oc.startRendering();
        return new File([encodeWav(b)], 'drum-loop.wav', { type: 'audio/wav' });
      })());
      // pad: sustained detuned triangles
      files.push(await (async () => {
        const secs = 6.0;
        const oc = new OfflineAudioContext(2, Math.round(sr * secs), sr);
        const g = oc.createGain(); g.gain.value = 0.22; g.connect(oc.destination);
        [220, 220.7, 329.6].forEach(f => { const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.connect(g); o.start(0); o.stop(secs); });
        const b = await oc.startRendering();
        return new File([encodeWav(b)], 'pad-chord.wav', { type: 'audio/wav' });
      })());
      // arp: filtered noise bursts
      files.push(await (async () => {
        const secs = 3.0;
        const oc = new OfflineAudioContext(2, Math.round(sr * secs), sr);
        const buf = oc.createBuffer(1, sr * secs, sr);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i += 1) d[i] = (Math.random() * 2 - 1) * 0.5;
        const src = oc.createBufferSource(); src.buffer = buf;
        const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 6;
        const g = oc.createGain();
        for (let i = 0; i < 12; i += 1) { const t = i * 0.25; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.7, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); }
        src.connect(bp); bp.connect(g); g.connect(oc.destination); src.start(0);
        const b = await oc.startRendering();
        return new File([encodeWav(b)], 'arp-noise.wav', { type: 'audio/wav' });
      })());
      window.__demo = files;
      return files.map(f => f.name);
    })()`);
    console.log('demo audio: ' + made.join(', '));

    await evaluate(`addFiles(window.__demo, null)`);
    await sleep(300);
    console.log('after add: ' + JSON.stringify(await evaluate('({tracks: state.tracks.length, clips: countClips(), total: computeDuration()})')));

    // arrange: nudge the arp onto a later start, split the pad at the playhead
    await evaluate(`(() => {
      const t = state.tracks[1].clips[0];
      setClipGeometry(t, { start: 1.5 }); t.start = 1.5;
      const a = state.tracks[2].clips[0];
      setClipGeometry(a, { start: 0.75 }); a.start = 0.75;
      setPlayhead(2.5);
      selectClip(state.tracks[0].clips[0].id);
      splitSelectedAtPlayhead();
      selectClip(state.tracks[2].clips[0].id);
      UI.renderAll();
      return { clips: countClips(), total: +computeDuration().toFixed(2) };
    })()`);
    await sleep(250);

    const shot = async name => {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('wrote ' + path.join(OUT, name));
    };
    const shotClip = async (name, clip) => {
      const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 }, captureBeyondViewport: false });
      writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('wrote ' + path.join(OUT, name));
    };
    await shot('01-timeline-fit.png');

    await evaluate(`(() => { setZoom(300, 1.0); return state.ppp; })()`);
    await sleep(200);
    await shot('02-timeline-zoomed.png');

    await evaluate(`playFrom(0)`);
    await sleep(1200);
    await shot('03-playing.png');
    await evaluate(`pausePlayback()`);

    // select a track through the header, to check the inspector's track panel
    const trackSel = await evaluate(`(() => {
      stopPlayback();
      const head = document.querySelectorAll('.lane-head')[1];
      head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 3, clientX: head.getBoundingClientRect().left + 3, clientY: head.getBoundingClientRect().top + 3, button: 0 }));
      const g = head.querySelector('.lh-mid input');
      g.value = 0.45; g.dispatchEvent(new Event('input', { bubbles: true }));
      const m = document.querySelectorAll('.lane-head')[2].querySelector('[data-act="mute"]');
      m.click();
      return { sel: state.sel && state.sel.type, gain: state.tracks[1].gain, muted: state.tracks[2].muted };
    })()`);
    console.log('track selection: ' + JSON.stringify(trackSel));
    await sleep(200);
    const inspectDom = await evaluate(`(() => {
      const out = [];
      document.querySelectorAll('#inspector *').forEach(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').join('.') : '') +
          ' vis=' + cs.display + (el.hidden ? ' HIDDEN-ATTR' : '') + ' rect=' + [r.x, r.y, r.width, r.height].map(n => Math.round(n)).join(','));
      });
      return out;
    })()`);
    console.log('inspector dom:\n' + inspectDom.join('\n'));
    await shot('04-track-selected.png');
    await shotClip('05-inspector-closeup.png', { x: 1183, y: 150, width: 245, height: 140 });
    const hitTest = await evaluate(`(() => {
      const pts = [[1210,190],[1215,196],[1220,200],[1195,185],[1240,195]];
      return pts.map(([x,y]) => { const el = document.elementFromPoint(x, y); const r = el ? el.getBoundingClientRect() : null;
        return x + ',' + y + ' -> ' + (el ? el.tagName.toLowerCase() + (el.id?'#'+el.id:'') + (el.className?'.'+String(el.className).split(' ').join('.'):'') + ' ' + [r.x,r.y,r.width,r.height].map(Math.round).join(',') : 'null'); });
    })()`);
    console.log('hit test:\n' + hitTest.join('\n'));

    // end line / total length with 0.01 s precision
    const endInfo = await evaluate(`(() => {
      const target = Math.round((computeDuration() - 1.0) * 100) / 100;
      setProjectEnd(target + 0.004);                  // proves the 0.01 s rounding
      UI.zoomToFit();
      UI.renderAll();
      const flag = document.querySelector('.end-marker .end-flag');
      const fr = flag.getBoundingClientRect();
      const panel = document.getElementById('insp-project').getBoundingClientRect();
      const save = document.getElementById('btn-save-project').getBoundingClientRect();
      const foot = document.querySelector('.stage-foot').getBoundingClientRect();
      return { content: +computeDuration().toFixed(2), end: state.end, requested: +(target + 0.004).toFixed(3),
               projectEnd: projectEnd(), dirty: projectIsDirty(), flagText: flag.textContent,
               badge: document.getElementById('stat-end').textContent,
               unsavedBadge: document.getElementById('stat-unsaved').textContent,
               needsSave: document.getElementById('btn-save-project').classList.contains('needs-save'),
               inputValue: document.getElementById('proj-end').value,
               inputStep: document.getElementById('proj-end').step,
               flagRect: [fr.x, fr.y, fr.width, fr.height].map(Math.round),
               panelRect: [panel.x, panel.y, panel.width, panel.height].map(Math.round),
               saveRect: [save.x, save.y, save.width, save.height].map(Math.round),
               footRect: [foot.x, foot.y, foot.width, foot.height].map(Math.round) };
    })()`);
    console.log('end line: ' + JSON.stringify(endInfo));
    await sleep(250);
    await shot('06-end-line.png');
    await shotClip('07-end-line-flag.png', {
      x: Math.min(endInfo.panelRect[0] - 300, Math.max(215, endInfo.flagRect[0] - 220)),
      y: endInfo.flagRect[1] - 45, width: 290, height: 230
    });
    await shotClip('08-end-line-inspector.png', {
      x: endInfo.panelRect[0] - 8, y: endInfo.panelRect[1] - 34,
      width: endInfo.panelRect[2] + 16, height: endInfo.panelRect[3] + 44, scale: 2
    });
    await shotClip('09-unsaved-indicator.png', {
      x: endInfo.saveRect[0] - 14, y: endInfo.saveRect[1] - 10,
      width: endInfo.saveRect[2] + 28, height: endInfo.saveRect[3] + 20
    });
    await shotClip('10-unsaved-status.png', {
      x: endInfo.footRect[0] + 4, y: endInfo.footRect[1] - 4, width: 560, height: endInfo.footRect[3] + 8
    });
  } finally {
    try { ws && ws.close(); } catch {}
    proc.kill();
    for (let i = 0; i < 8; i += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(400); }
    }
  }
}
main().catch(e => { console.error('SHOTS_ERROR ' + (e && e.stack || e)); process.exit(1); });
