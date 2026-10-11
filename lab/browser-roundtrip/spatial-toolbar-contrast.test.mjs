import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DONE_LABEL_ALPHA, MENU_IDLE_ALPHA, MENU_PLAY_ALPHA, STATE_PLATE_STYLE, TOOLBAR_TEXT_DRAW,
  menuAlpha, toolbarDoneTextProps, toolbarPlateProps, toolbarTextProps,
} from './spatial-toolbar-contrast.mjs';

test('idle caption and menu glass is 70-80% opaque near-black', () => {
  assert.ok(MENU_IDLE_ALPHA.plates >= 0.70 && MENU_IDLE_ALPHA.plates <= 0.80,
    `idle plates ${MENU_IDLE_ALPHA.plates} is outside the 70-80% band`);
  assert.equal(MENU_IDLE_ALPHA.labels, 1);
  assert.equal(MENU_IDLE_ALPHA.readout, 1);
});

test('the asleep toolbar still has a dark backing, just a lower one', () => {
  assert.ok(MENU_PLAY_ALPHA.plates < MENU_IDLE_ALPHA.plates,
    'dimmed plates must drop below idle so the menu still looks stood-back');
  assert.ok(MENU_PLAY_ALPHA.plates >= 0.60,
    `dimmed plates ${MENU_PLAY_ALPHA.plates} would wash out on a white wall again`);
  assert.ok(MENU_PLAY_ALPHA.labels < MENU_IDLE_ALPHA.labels);
  assert.equal(MENU_PLAY_ALPHA.readout, 1, 'caption type stays filled while the buttons dim');
  assert.deepEqual(menuAlpha(false), MENU_IDLE_ALPHA);
  assert.deepEqual(menuAlpha(true), MENU_PLAY_ALPHA);
});

test('toolbar type is a filled glyph, not a hollow stroke', () => {
  assert.equal(TOOLBAR_TEXT_DRAW.borderWidth, 0);
  assert.equal(TOOLBAR_TEXT_DRAW.background, false);
  assert.equal(toolbarTextProps(0.55).borderWidth, 0);
  assert.equal(toolbarTextProps(1).background, false);
  assert.equal(toolbarTextProps(0.7).alpha, 0.7);
  assert.equal(toolbarPlateProps(0.8).alpha, 0.8);
  assert.equal(toolbarPlateProps(0.7).ignoreLight, false);
});

test('the painter draws with those props and never reintroduces a stroke', () => {
  const source = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/spatial-toolbar-contrast\.mjs'/);
  assert.match(source, /toolbarTextProps\(/);
  assert.match(source, /toolbarPlateProps\(/);
  const positiveStroke = [...source.matchAll(/borderWidth\s*:\s*([0-9.]+)/g)]
    .map(match => Number(match[1]))
    .filter(width => width > 0);
  assert.deepEqual(positiveStroke, [], 'spatial-toolbar.mjs must not stroke toolbar type');
});

test('the recessed Done label reads in button text at reduced alpha', () => {
  // The last chapter's Done was near-black on near-black and vanished on a
  // passthrough wall. Same text colour as the other rows,
  // dimmed to read as inactive rather than recolored.
  assert.equal(DONE_LABEL_ALPHA, 0.6);
  const props = toolbarDoneTextProps();
  assert.equal(props.alpha, DONE_LABEL_ALPHA);
  assert.equal(props.borderWidth, 0, 'a recessed label is still a filled glyph');
  assert.equal(props.background, false);
  const source = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
  assert.match(source, /toolbarDoneTextProps\(\)/);
  assert.match(source, /STATE_PLATE_STYLE/);
  assert.doesNotMatch(source, /dimText/, 'no near-black label colour may remain');
});

test('the recessed chip fill is raised but still darker than a button', () => {
  const hex = value => Number(value);
  assert.ok(hex(STATE_PLATE_STYLE.face) > 0x101b21, 'the Done fill must leave near-black behind');
  assert.ok(hex(STATE_PLATE_STYLE.face) < 0x2a4d5a, 'the Done fill must stay darker than an action plate');
  assert.ok(hex(STATE_PLATE_STYLE.edge) > 0x16242b, 'the Done edge must leave near-black behind');
  assert.ok(hex(STATE_PLATE_STYLE.edge) < 0x77bcc7, 'the Done edge must stay darker than a button edge');
});
