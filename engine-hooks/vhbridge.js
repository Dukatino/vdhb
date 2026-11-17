// Live preview bridge, put first in every film page by VideoHub. The review window reaches the film only through
// these messages, so a film page never needs (or gets) access to VideoHub's own window.
// Requests: { vh: 1, id, op, args } from the VideoHub origin in data-hub. Replies: { vh: 1, id, ok, value | error }.
// Events: { vh: 1, ev: 'error' | 'key', ... }.
(() => {
  const HUB = document.currentScript && document.currentScript.dataset.hub;
  if (!HUB || window.parent === window) return;
  const post = (m, transfer = []) => window.parent.postMessage({ vh: 1, ...m }, HUB, transfer);
  const clone = v => { try { return v == null ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } };
  const list = v => Array.isArray(v) && v.length > 0;

  addEventListener('error', e => { window.__vhError = e.message; post({ ev: 'error', error: String(e.message || 'Script error') }); });
  // a key pressed after a click on the film still drives VideoHub (Space = play); VideoHub decides which keys count
  for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault(); e.stopPropagation();
    post({ ev: 'key', type, key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat });
  }, true);

  function biggestCanvas() {
    const cv = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return cv ? { width: cv.width, height: cv.height } : null;
  }
  // every visible canvas of the page, in page order, scaled into one picture of `width` px (film size w x h)
  function picture(width, w, h) {
    const c = document.createElement('canvas'); c.width = width; c.height = Math.round(width * h / w);
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    const k = c.width / w;
    for (const cv of document.querySelectorAll('canvas')) {
      const r = cv.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(cv).display === 'none') continue;
      try { g.drawImage(cv, r.left * k, r.top * k, r.width * k, r.height * k); } catch { }
    }
    return c;
  }
  // shot names every 0.05 s, only for engines that offer nothing but __qaShotAt(t)
  function qaNames(dur) {
    const out = [];
    for (let t = 0; t < dur + 1e-9; t += 0.05) { let n = ''; try { n = String(window.__qaShotAt(Math.min(t, dur - 1e-3)) ?? ''); } catch { } out.push(n); }
    return out;
  }

  const ops = {
    state: () => ({
      ready: window.READY === true && typeof window.renderOut === 'function',
      error: window.__vhError ? String(window.__vhError) : null,
      config: clone(window.__config || window.VH_CONFIG),
      data: +(window.DATA && window.DATA.width) && +window.DATA.height ? { width: +window.DATA.width, height: +window.DATA.height } : null,
      canvas: biggestCanvas(),
    }),
    render: ({ t }) => {
      const a = performance.now(), r = window.renderOut(+t), done = () => ({ t: +t, ms: performance.now() - a });
      return r && typeof r.then === 'function' ? r.then(done) : done();
    },
    // t: draw that moment first, then draw `keep` again; the picture is copied in between, in the same task
    snap: ({ t, keep, width, w, h }) => {
      let c;
      try { if (t != null) window.renderOut(+t); c = picture(+width, +w, +h); }
      finally { if (t != null && keep != null && +keep !== +t) window.renderOut(+keep); }
      return createImageBitmap(c);
    },
    scenes: ({ dur }) => {
      let v = null; try { v = typeof window.VH_SCENES === 'function' ? window.VH_SCENES() : window.VH_SCENES; } catch { }
      const out = { VH_SCENES: clone(v), SHOTS: clone(window.SHOTS), EVENTS: { shots: clone(window.EVENTS && window.EVENTS.shots) }, PIECES: clone(window.PIECES), qa: null };
      if (!list(out.VH_SCENES) && !list(out.SHOTS) && !list(out.EVENTS.shots) && typeof window.__qaShotAt === 'function' && +dur > 0) out.qa = qaNames(+dur);
      return out;
    },
    qaShot: () => (typeof window.__qaShot === 'function' ? String(window.__qaShot()) : ''),
  };

  // a plain answer goes back in the same task, so a frame is drawn and reported before anything else runs
  addEventListener('message', e => {
    if (e.source !== window.parent || e.origin !== HUB) return;
    const m = e.data; if (!m || m.vh !== 1 || !Object.hasOwn(ops, m.op)) return;
    const reply = value => post({ id: m.id, ok: true, value }, typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap ? [value] : []);
    const fail = err => post({ id: m.id, ok: false, error: String((err && err.message) || err) });
    let value; try { value = ops[m.op](m.args || {}); } catch (err) { fail(err); return; }
    if (value && typeof value.then === 'function') value.then(reply, fail); else reply(value);
  });
})();
