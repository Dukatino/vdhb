// The film's scene editor (window.VH_EDIT, engine-hooks/vhtweaks.js) as seen from VideoHub's window.
// Calls go to the film page in order and return promises. Reads (get, shot, caps, freeState, overlays) come from
// the copy of the editor's state that the page sent with its last answer, so the panel can paint at once.
const QUIET = new Set(['nav', 'pivotAt']);   // many per second while dragging the camera: no state copy
const CALLS = ['set', 'nav', 'pivotAt', 'drag', 'pick', 'info', 'nudge', 'rotate', 'scale', 'hide', 'ground', 'resetObj',
  'saveCam', 'resetCam', 'freeStart', 'freeStop', 'ovMove', 'ovScale', 'ovHide', 'ovReset', 'soundSet', 'findCut', 'cutShift', 'cutTr', 'cutReset'];

export function createEditProxy(src) {
  let st = { shot: '', caps: {}, data: { shots: {}, cuts: [], sound: [] }, free: null, overlays: [], has: [] };
  let last = Promise.resolve();
  // the page answers in the order it was asked, so waiting for the newest call waits for all of them
  function call(method, args = []) {
    const p = src.ask('edit', { method, args, quiet: QUIET.has(method) }).then((r) => {
      if (r && r.state && typeof r.state === 'object') st = r.state;
      return r ? r.value ?? null : null;
    });
    last = p.catch(() => null);
    return p;
  }
  const proxy = {
    load: () => call(null).then(() => proxy),
    idle: () => last,
    has: (name) => Array.isArray(st.has) && st.has.includes(name),
    get: () => JSON.parse(JSON.stringify(st.data && typeof st.data === 'object' ? { shots: {}, ...st.data } : { shots: {} })),
    shot: () => String(st.shot || ''),
    caps: () => (st.caps && typeof st.caps === 'object' ? st.caps : {}),
    freeState: () => st.free,
    overlays: () => (Array.isArray(st.overlays) ? st.overlays : []),
  };
  for (const name of CALLS) proxy[name] = (...args) => call(name, args);
  return proxy;
}
