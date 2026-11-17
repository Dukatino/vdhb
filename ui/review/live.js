// Live source: plays a film from its own code instead of a video file. The film page (served by the hub at
// /live/<id>/...) draws any moment with window.renderOut(t) on fixed-size canvases. This object looks enough
// like an HTMLVideoElement (currentTime, play/pause, events, requestVideoFrameCallback) for the review player.
// While playing, the project's audio is the clock; frames that take too long are skipped, never slowed down.
// The film page is reached only through engine-hooks/vhbridge.js messages: a film may come from anywhere, and
// this window can run commands through the hub.
import { h } from '../app.js';
import { scenesFromPage } from './scenes.js';

// keys a film page may pass on to the player (Space = play); never editing keys such as Delete or Ctrl+Z
const FILM_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', ',', '.', 'Home', 'End', 'j', 'k', 'l', 'Escape']);

export function createLiveSource(info, { onStatus } = {}) {
  const box = h('div', { class: 'livebox' });
  const filmOrigin = new URL(info.url, location.href).origin;
  let waitTimer = 0, iframe = null, ready = false, t = 0, paused = true, rate = 1, seeking = false;
  let displayedTime = 0, destroyed = false, loadVersion = 0, seekVersion = 0, seekTimer = 0, playTimer = 0;
  let wantPlay = false;   // play asked for while the page was loading: start once it is ready
  let base = { t: 0, at: 0 }, raf = 0, need = false, rvfc = [], frames = 0, fpsAt = performance.now(), drawMs = 0, scale = 1;
  let drawing = false, drawingAt = null, drawAgain = false;   // one renderOut in flight: slow frames are skipped
  const audio = info.audio ? h('audio', { src: info.audio, preload: 'auto' }) : null;
  const src = new EventTarget();
  const fire = type => src.dispatchEvent(new Event(type));
  const status = s => onStatus && onStatus(s);
  const clampTime = value => Math.max(0, Math.min(info.dur, +value || 0));

  // A request to the film page; done(error, value) runs when the page answers, or after `ms` without an answer.
  let seq = 0; const calls = new Map();
  function send(op, args, done, ms = 15000) {
    const w = iframe && iframe.contentWindow;
    if (!w || destroyed) { done(new Error('The film page is not loaded.')); return; }
    const id = ++seq;
    calls.set(id, { done, timer: setTimeout(() => { const c = calls.get(id); if (c) { calls.delete(id); c.done(new Error('The film page did not answer.')); } }, ms) });
    try { w.postMessage({ vh: 1, id, op, args }, filmOrigin); }
    catch (e) { const c = calls.get(id); if (c) { calls.delete(id); clearTimeout(c.timer); c.done(e); } }
  }
  const ask = (op, args, ms) => new Promise((resolve, reject) => send(op, args, (e, v) => (e ? reject(e) : resolve(v)), ms));
  function dropCalls() {
    const all = [...calls.values()]; calls.clear();
    for (const c of all) { clearTimeout(c.timer); try { c.done(new Error('The film page was reloaded.')); } catch { } }
  }
  function forwardKey(m) {
    if (!FILM_KEYS.has(m.key) || m.ctrlKey || m.metaKey || m.altKey || (m.type !== 'keydown' && m.type !== 'keyup')) return;
    document.dispatchEvent(new KeyboardEvent(m.type, { key: m.key, code: String(m.code || ''), shiftKey: !!m.shiftKey, repeat: !!m.repeat, bubbles: true, cancelable: true }));
  }
  function onMessage(e) {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== filmOrigin) return;
    const m = e.data; if (!m || m.vh !== 1) return;
    if (m.id != null) {
      const c = calls.get(m.id); if (!c) return;
      calls.delete(m.id); clearTimeout(c.timer);
      c.done(m.ok ? null : new Error(String(m.error || 'The film page failed.')), m.value); return;
    }
    if (m.ev === 'error' && !ready) { clearInterval(waitTimer); status({ state: 'error', error: String(m.error || 'Script error') }); }
    else if (m.ev === 'key') forwardKey(m);
  }
  window.addEventListener('message', onMessage);

  function clearSeek() {
    ++seekVersion; clearTimeout(seekTimer); seekTimer = 0;
    seeking = false; need = false;
  }

  function load() {
    if (destroyed) return;
    const version = ++loadVersion;
    dropCalls(); drawing = false; drawingAt = null; drawAgain = false;
    clearTimeout(playTimer); playTimer = 0; rvfc = [];
    ready = false; status({ state: 'loading' });
    const q = `vhparent=${encodeURIComponent(location.origin)}&vh=${Date.now()}`;
    const f = h('iframe', { class: 'live', src: `${info.url}${info.url.includes('?') ? '&' : '?'}${q}`, scrolling: 'no', tabindex: '-1' });
    f.style.width = info.w + 'px'; f.style.height = info.h + 'px'; f.style.transform = `scale(${scale})`;
    if (iframe) iframe.replaceWith(f); else box.append(f);
    iframe = f;
    const t0 = performance.now();
    let asking = false;
    clearInterval(waitTimer);
    // a message sent before the page and its bridge have loaded is lost: ask again after a short wait
    const wait = waitTimer = setInterval(() => {
      if (destroyed || version !== loadVersion || asking) return;
      if (performance.now() - t0 > 120000) { clearInterval(wait); status({ state: 'error', error: 'The page was not ready within 2 minutes (no READY signal).' }); return; }
      asking = true;
      send('state', null, (err, s) => {
        asking = false;
        if (err || !s || destroyed || version !== loadVersion || waitTimer !== wait) return;
        if (s.error) { clearInterval(wait); status({ state: 'error', error: s.error }); return; }
        if (!s.ready) return;
        clearInterval(wait); ready = true; status({ state: 'ready', ms: Math.round(performance.now() - t0) });
        if (wantPlay) playTimer = setTimeout(() => { playTimer = 0; if (!destroyed && version === loadVersion && wantPlay) play(); }, 50);
        // the page may know its own timing and size better (the 3D studio sets window.__config); else its DATA
        // size, else its biggest canvas when its shape differs (a 9:16 film must not show only its top square)
        let c = s.config || s.data;
        if (!c && s.canvas && s.canvas.width >= 64 && s.canvas.height >= 64 && Math.abs(s.canvas.width / s.canvas.height - info.w / info.h) > 0.01) c = s.canvas;
        if (c) {
          if (+c.fps) info.fps = +c.fps; if (+c.duration) info.dur = +c.duration;
          const w = +(c.outWidth || c.width), hh = +(c.outHeight || c.height); if (w && hh) { info.w = w; info.h = hh; iframe.style.width = w + 'px'; iframe.style.height = hh + 'px'; }
        }
        present(); fire('loadedmetadata'); fire('timeupdate');
      }, 400);
    }, 100);
  }

  // A seek completes only when the frame asked for after it is on screen.
  function draw() {
    if (!ready || destroyed) return;
    const at = t;
    if (drawing) { if (at !== drawingAt) drawAgain = true; return; }
    drawing = true; drawingAt = at;
    const version = loadVersion, seekV = seeking ? seekVersion : 0, a = performance.now();
    send('render', { t: at }, err => {
      if (version !== loadVersion || destroyed) return;
      drawing = false; drawingAt = null;
      if (err) { drawAgain = false; status({ state: 'error', error: err.message }); return; }
      displayedTime = at;
      drawMs = drawMs * 0.8 + (performance.now() - a) * 0.2;
      frames++;
      const cbs = rvfc; rvfc = []; for (const cb of cbs) try { cb(performance.now(), { mediaTime: at }); } catch { }
      if (seekV && seekV === seekVersion && seeking) {
        seeking = false; need = false; clearTimeout(seekTimer); seekTimer = 0;
        fire('seeked'); fire('timeupdate');
      }
      if (drawAgain) { drawAgain = false; draw(); }
    }, 30000);
  }
  const present = () => draw();
  // the film's clock: its own, unless the sound is really playing (loaded, not seeking); a sound still loading or stalled
  // used to hold the picture at its time (0) — now the picture goes on and the sound is brought to it once it can play
  // the film's clock is the picture's own: the sound never sets it (a big WAV in Edge "played" at 0 for seconds, then
  // jumped). The sound follows: moved to the picture when it drifts more than 0.2 s, checked twice a second.
  const clock = () => base.t + (performance.now() - base.at) / 1000 * rate;
  let syncAt = 0;
  function syncAudio() {
    const now = performance.now(); if (!audio || now - syncAt < 500) return; syncAt = now;
    if (audio.paused || audio.ended || audio.seeking || audio.readyState < 2) return;
    if (t < (audio.duration || Infinity) - 0.3 && Math.abs(audio.currentTime - t) > 0.2) try { audio.currentTime = t; } catch { }
  }
  function loop() {
    if (destroyed) return;
    raf = requestAnimationFrame(loop);
    if (!paused) {
      t = Math.min(info.dur, clock()); syncAudio();
      present(); if (frames % 6 === 0) fire('timeupdate');
      if (t >= info.dur - 1e-3) { pause(); fire('ended'); }
    } else if (need) { present(); }
    const now = performance.now();
    if (now - fpsAt > 1000) { status({ state: paused ? 'paused' : 'playing', fps: Math.round(frames * 1000 / (now - fpsAt)), drawMs: Math.round(drawMs) }); frames = 0; fpsAt = now; }
  }
  raf = requestAnimationFrame(loop);

  function play() {
    if (destroyed) return Promise.resolve();
    if (!ready) { const asked = wantPlay; wantPlay = true; status({ state: 'loading', note: 'will play when ready' }); if (!asked) fire('play'); return Promise.resolve(); }
    if (!paused) return Promise.resolve();   // HTMLVideoElement.play() is idempotent; never rewind to the last rendered frame.
    wantPlay = false;
    if (t >= info.dur - 1e-3) t = 0;
    paused = false; base = { t, at: performance.now() };
    if (audio) { try { audio.currentTime = t; audio.playbackRate = rate; } catch { } audio.play().catch(() => { }); }
    fire('play'); return Promise.resolve();
  }
  function pause() {
    const waited = wantPlay; wantPlay = false;
    if (paused) { if (waited) fire('pause'); return; }
    pauseAt(seeking ? t : displayedTime);
  }
  // Notes freeze the frame the user actually saw, even if a slow render left the clock several seconds ahead.
  function pauseAt(at) {
    if (destroyed) return;
    at = clampTime(at);
    if (paused && !wantPlay && !seeking && !need && t === at && displayedTime === at) return;
    const wasPlaying = !paused || wantPlay; wantPlay = false;
    t = at; paused = true; base = { t, at: performance.now() }; clearSeek();
    audio?.pause(); if (audio) try { audio.currentTime = t; } catch { }
    if (displayedTime !== t) draw();
    if (wasPlaying) fire('pause');
    fire('timeupdate');
  }

  // The page draws `at`, copies its canvases into one picture of `width` px and draws `keep` again, in one task.
  // at = null: the moment on screen, drawn again so a WebGL picture is still there to copy; playback is untouched.
  async function snap(at, width = 1280) {
    if (!ready || destroyed) return null;
    const keep = displayedTime, moment = at == null ? keep : clampTime(at);
    try {
      const bmp = await ask('snap', { t: moment, keep, width, w: info.w, h: info.h });
      if (!bmp || destroyed) return null;
      const c = document.createElement('canvas'); c.width = width; c.height = Math.round(width * info.h / info.w);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      return c;
    } catch (e) { if (at != null && !destroyed) status({ state: 'error', error: e.message }); return null; }
  }
  const snapDisplayed = (width = 480) => snap(null, width);
  const capture = async (at, width) => (await snap(at, width))?.toDataURL('image/jpeg', 0.9) || null;
  // the film's scenes for the timeline (see scenes.js); the page sends plain data, never its functions
  async function scenes(dur) {
    if (!ready || destroyed) return { scenes: [], source: null };
    const raw = await ask('scenes', { dur });
    const names = Array.isArray(raw?.qa) ? raw.qa : null;
    return scenesFromPage({ VH_SCENES: raw?.VH_SCENES, SHOTS: raw?.SHOTS, EVENTS: raw?.EVENTS, PIECES: raw?.PIECES, ...(names ? { __qaShotAt: at => names[Math.round(at / 0.05)] ?? '' } : {}) }, dur);
  }

  Object.defineProperties(src, {
    displayedTime: { get: () => displayedTime },
    currentTime: { get: () => paused ? t : Math.min(info.dur, clock()), set: v => {
      if (destroyed) return;
      t = clampTime(v); base = { t, at: performance.now() };
      if (audio) try { audio.currentTime = t; } catch { }
      seeking = true; need = true; const version = ++seekVersion; clearTimeout(seekTimer);
      // Background windows may receive no animation frames; playing and paused seeks must both settle.
      seekTimer = setTimeout(() => {
        seekTimer = 0;
        if (destroyed || version !== seekVersion || !need || !ready) return;
        if (!paused) t = Math.min(info.dur, clock());
        present();
      }, 150);
      fire('seeking');
    } },
    paused: { get: () => paused && !wantPlay },
    win: { get: () => iframe?.contentWindow || null },   // the page itself (scene editor: window.VH_EDIT)
    seeking: { get: () => seeking },
    ended: { get: () => t >= info.dur - 1e-3 },
    duration: { get: () => info.dur },
    videoWidth: { get: () => info.w }, videoHeight: { get: () => info.h },
    playbackRate: { get: () => rate, set: v => { const now = src.currentTime; rate = +v || 1; base = { t: now, at: performance.now() }; if (audio) audio.playbackRate = rate; } },
    volume: { get: () => audio ? audio.volume : 1, set: v => { if (audio) audio.volume = v; } },
    muted: { get: () => audio ? audio.muted : true, set: v => { if (audio) audio.muted = v; } },
  });
  Object.assign(src, {
    el: box, isLive: true, info, play, pause, pauseAt, capture, snap, snapDisplayed, scenes, ask,
    requestVideoFrameCallback: cb => { if (destroyed) return 0; rvfc.push(cb); return rvfc.length; },
    // the film's sound file was rebuilt (scene editor sound levels): load it again, same moment
    // a fresh mix after a sound build; while playing it carries on from the clock (a new src pauses the element)
    reloadAudio() {
      if (!audio || !info.audio) return;
      audio.src = info.audio + (info.audio.includes('?') ? '&' : '?') + 'v=' + Date.now();
      const sync = () => { try { audio.currentTime = src.currentTime; audio.playbackRate = rate; } catch { } if (!paused && !destroyed) audio.play().catch(() => { }); };
      audio.addEventListener('loadedmetadata', sync, { once: true }); sync();
    },
    // the hub saw the code change: reload the page and come back to the same moment
    reload(nextInfo) {
      if (destroyed) return;
      const wasPlaying = !paused || wantPlay; pause(); clearSeek();
      if (nextInfo) {
        Object.assign(info, nextInfo);
        if (audio && info.audio) audio.src = info.audio + (info.audio.includes('?') ? '&' : '?') + 'v=' + Date.now();
      }
      load(); wantPlay = wasPlaying;
    },
    fit(w) { scale = w / info.w; if (iframe) iframe.style.transform = `scale(${scale})`; },
    destroy() { destroyed = true; ready = false; paused = true; wantPlay = false; ++loadVersion; clearInterval(waitTimer); clearTimeout(playTimer); clearSeek(); cancelAnimationFrame(raf); rvfc = []; dropCalls(); window.removeEventListener('message', onMessage); audio?.pause(); if (audio) { audio.removeAttribute('src'); audio.load(); } iframe?.remove(); iframe = null; },
    // the review player calls these on <video>; nothing to do here
    removeAttribute() { }, load() { },
  });
  load();
  return src;
}
