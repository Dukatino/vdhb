import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parentOrigin, withBridge } from './live.js';

// the hub's request check, run on its own: film pages come from another port and must be refused
const hub = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8');
const check = hub.slice(hub.indexOf('const LOOPBACK'), hub.indexOf('\n}\n', hub.indexOf('function foreign(req)')) + 2);
const ctx = { URL, server: { address: () => ({ port: 7788 }) } };
vm.createContext(ctx); vm.runInContext(check + '\nthis.foreign = foreign;', ctx);
const req = (method, headers) => ({ method, headers: { host: '127.0.0.1:7788', ...headers } });

test('the hub refuses film pages and other sites for every method, and keeps its own window and tools', () => {
  const film = 'http://127.0.0.1:51234';
  assert.equal(ctx.foreign(req('GET', {})), null, 'MCP tools and scripts send no Origin');
  assert.equal(ctx.foreign(req('POST', { origin: 'http://127.0.0.1:7788', 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(ctx.foreign(req('POST', { origin: film, 'sec-fetch-site': 'same-site' })), 'site');
  assert.equal(ctx.foreign(req('GET', { 'sec-fetch-site': 'same-site' })), 'site');
  assert.equal(ctx.foreign(req('GET', { origin: film })), 'origin', 'a browser without Sec-Fetch-Site is still refused');
  assert.equal(ctx.foreign(req('POST', { origin: film })), 'origin');
  assert.equal(ctx.foreign(req('GET', { origin: 'null' })), 'origin', 'an opaque (sandboxed) origin is refused');
  assert.equal(ctx.foreign({ method: 'GET', headers: { host: 'evil.test:7788' } }), 'host');
});

test('a film page talks only to a loopback VideoHub window on the hub port', () => {
  const at = q => parentOrigin('/live/abc/index.html?vhparent=' + encodeURIComponent(q), 7788);
  assert.equal(at('http://127.0.0.1:7788'), 'http://127.0.0.1:7788');
  assert.equal(at('http://localhost:7788/x'), 'http://localhost:7788');
  for (const bad of ['http://127.0.0.1:9999', 'https://127.0.0.1:7788', 'http://evil.test:7788', 'javascript:alert(1)', '']) assert.equal(at(bad), null, bad);
  assert.equal(parentOrigin('/live/abc/index.html', 7788), null);
});

test('the bridge is the first script of the page, and only for a known VideoHub window', () => {
  const page = '<!doctype html><html><head><script>window.x=1</script></head><body></body></html>';
  const out = withBridge(page, 'http://127.0.0.1:7788');
  assert.ok(out.indexOf('/__vh/bridge.js') < out.indexOf('window.x=1'));
  assert.match(out, /data-hub="http:\/\/127\.0\.0\.1:7788"/);
  assert.equal(withBridge(page, null), page);
  assert.ok(withBridge('<canvas></canvas>', 'http://127.0.0.1:7788').startsWith('<script src="/__vh/bridge.js"'));
});
