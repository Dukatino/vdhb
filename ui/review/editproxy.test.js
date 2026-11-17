import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditProxy } from './editproxy.js';

function fakeSource() {
  const sent = [], pending = [];
  const src = { ask: (op, args) => new Promise((resolve, reject) => { sent.push({ op, args }); pending.push({ resolve, reject }); }) };
  return { src, sent, answer: (v) => pending.shift().resolve(v), fail: (e) => pending.shift().reject(e) };
}

test('reads come from the state the page sent with its last answer', async () => {
  const f = fakeSource(), E = createEditProxy(f.src);
  assert.deepEqual(E.get(), { shots: {}, cuts: [], sound: [] }); assert.equal(E.shot(), ''); assert.deepEqual(E.overlays(), []);
  const loaded = E.load();
  f.answer({ value: null, state: { shot: 'A', caps: { cuts: true }, data: { shots: { A: { camera: {} } }, cuts: [] }, free: { fov: 40 }, overlays: [{ id: 'x' }], has: ['soundSet'] } });
  assert.equal(await loaded, E);
  assert.equal(E.shot(), 'A'); assert.equal(E.freeState().fov, 40); assert.equal(E.has('soundSet'), true); assert.equal(E.has('pick'), false);
  const copy = E.get(); copy.shots.A.camera.fov = 1; assert.deepEqual(E.get().shots.A.camera, {}, 'get() hands out a copy');
  assert.deepEqual(f.sent[0], { op: 'edit', args: { method: null, args: [], quiet: false } });
});

test('calls keep their order, camera drags ask for no state, and idle waits for the newest call', async () => {
  const f = fakeSource(), E = createEditProxy(f.src);
  const nav = E.nav('orbit', 0.1, 0), cut = E.cutShift(5, 2, 60);
  assert.deepEqual(f.sent.map((s) => [s.args.method, s.args.quiet]), [['nav', true], ['cutShift', false]]);
  let idle = false; E.idle().then(() => { idle = true; });
  f.answer({ value: null, state: null }); await nav; await Promise.resolve();
  assert.equal(idle, false);
  f.answer({ value: 0.0333, state: { shot: 'B', data: { shots: {}, cuts: [{ at: 5, d: 0.0333 }] } } });
  assert.equal(await cut, 0.0333); await E.idle(); assert.equal(idle, true); assert.equal(E.shot(), 'B');
});

test('a failed call rejects for its caller but never leaves idle() rejected', async () => {
  const f = fakeSource(), E = createEditProxy(f.src);
  const p = E.pick(0, 0); f.fail(new Error('no editor'));
  await assert.rejects(p, /no editor/); assert.equal(await E.idle(), null);
});
