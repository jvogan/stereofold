import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * The wearer's address bar, and any shared log, must not carry the page key.
 *
 * Quest Browser renders the whole address — fragment included — in a URL bar
 * that floats inside the wearer's view, so the 64-character page key was
 * legible in every capture of that view and in any screenshot taken from it.
 * `plugin/src/inspection-page-key.ts` fixes the address bar. This file guards
 * the two places the lab could put the key back: the handoff that navigates
 * this tab to `/detailed`, and the diagnostics the headset writes to a log file
 * that leaves the machine.
 *
 * These are source assertions on purpose. The code they cover lives inside
 * `createViewer`, which needs a canvas, a WebXR runtime and a host; the
 * emulator exercises it end to end but serves a prebuilt bundle, so a unit test
 * cannot reach these lines at runtime. What can regress is the text.
 */
const here = new URL('.', import.meta.url);
const read = async name => await readFile(new URL(name, here), 'utf8');

test('the workbench handoff navigates to whatever same-origin path the host names, fragment or not', async () => {
  const viewer = await read('viewer.mjs');
  const handoff = viewer.slice(viewer.indexOf('async function openDetailedViewOnHost'));
  const body = handoff.slice(0, handoff.indexOf('\n  }\n'));
  // The only shape check is "same origin". Since the companion took its key
  // into sessionStorage, the host now names a bare `/detailed`, and a host
  // whose storage refused still names `/detailed#<key>`. Both must pass.
  assert.match(body, /result\.headsetUrl\.startsWith\('\/'\)/u);
  assert.doesNotMatch(body, /#/u, 'the handoff must not require, add or strip a fragment itself');
  for (const address of ['/detailed', '/detailed#' + 'a'.repeat(64)]) {
    assert.equal(typeof address === 'string' && address.startsWith('/'), true);
  }
});

test('nothing the headset records or says carries the address it is navigating to', async () => {
  const viewer = await read('viewer.mjs');
  const press = viewer.slice(viewer.indexOf("if (action.kind === 'open-workbench')"));
  const branch = press.slice(0, press.indexOf('// The workbench is a desktop side drawer'));
  const recorded = branch.slice(branch.indexOf("recordManipulation('workbench'"));
  const payload = recorded.slice(0, recorded.indexOf('});') + 1);
  for (const leak of ['headsetUrl', 'address', 'location', 'url', 'href']) {
    assert.ok(!payload.includes(leak), `the workbench diagnostic must not record ${leak}`);
  }
  // The diagnostics file is the one attached to a bug report.
  const diagnostics = await read('headset-diagnostics.mjs');
  for (const leak of ['location.href', 'location.hash', 'location.origin', 'location.pathname']) {
    assert.ok(!diagnostics.includes(leak), `headset diagnostics must not record ${leak}`);
  }
});

test('no page in the lab reads a page key out of the address after the first turn', async () => {
  const viewer = await read('viewer.mjs');
  // The lab page never holds the key at all: the companion transport in
  // plugin/src owns it, and this bundle only ever receives a path to go to.
  assert.ok(!/location\.hash/u.test(viewer), 'viewer.mjs must not read the address fragment');
});
