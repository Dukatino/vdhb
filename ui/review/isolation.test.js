import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A film page runs on its own origin and is reached only through engine-hooks/vhbridge.js messages.
const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the 2D layers editor still looks for the page's window.VH2D; it finds none and keeps its button hidden
const ALLOWED = { 'review/edit2d.js': /\bsrc\.win\b/g };

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(f)); else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(f);
  }
  return out;
}

test('no UI code reaches into the film page window', () => {
  const bad = [];
  for (const f of files(UI)) {
    const rel = path.relative(UI, f).replaceAll('\\', '/');
    let code = fs.readFileSync(f, 'utf8');
    if (ALLOWED[rel]) code = code.replace(ALLOWED[rel], '');
    for (const [name, re] of [['contentDocument', /\bcontentDocument\b/], ['contentWindow property', /contentWindow\??\.(?!postMessage\b)/], ['src.win', /\b(?:src|liveSrc|source)\??\.win\b/]]) {
      if (re.test(code)) bad.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(bad, []);
});

// film text (errors, scene and object names, labels) reaches the UI; it must stay text, never markup
test('the UI parses no text as HTML except its own fixed icons', () => {
  const bad = [];
  for (const f of files(UI)) {
    const rel = path.relative(UI, f).replaceAll('\\', '/'), code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(/(?:innerHTML|outerHTML)\s*=\s*([^;\n]+)|insertAdjacentHTML|\bhtml\s*:/g)) {
      if (m[1] && /^(?:''|""|ICON\[[a-z]+\])$/.test(m[1].trim())) continue;
      if (rel === 'app.js' && /else if \(k === 'html'\) el\.innerHTML = v/.test(code.slice(m.index - 30, m.index + 30))) continue;
      bad.push(`${rel}: ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the live player gives the film page its own sandboxed frame and no window handle', () => {
  const live = fs.readFileSync(path.join(UI, 'review', 'live.js'), 'utf8');
  assert.match(live, /sandbox: 'allow-scripts allow-same-origin'/);
  assert.doesNotMatch(live, /\bwin: \{/);
});
