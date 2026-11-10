import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const electron = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/LiveDomLab.tsx', import.meta.url), 'utf8');
const staticLab = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const creatorBridge = fs.readFileSync(new URL('../../../src/main/visual-match-lab-bridge.ts', import.meta.url), 'utf8');

test('lab shell never creates or navigates a Facebook browser', () => {
  assert.doesNotMatch(electron, /WebContentsView|partition|facebook\.com|startUrl/);
  assert.match(electron, /CREATOR_BROWSERCORE_UNAVAILABLE/);
});

test('Creator bridge returns and enforces one webContents id', () => {
  assert.match(creatorBridge, /const webContentsId = wc\.id/);
  assert.match(creatorBridge, /WRONG_BROWSER_INSTANCE/);
  assert.match(creatorBridge, /BROWSER_INSTANCE_CHANGED/);
});

test('login evidence uses Facebook DOM without reading cookies', () => {
  assert.match(creatorBridge, /FACEBOOK_NOT_LOGGED_IN/);
  assert.doesNotMatch(creatorBridge, /cookies|getAllCookies|document\.cookie/i);
});

test('maps screenshot pixels to current BrowserCore CSS viewport', () => {
  assert.match(ui, /capture\.viewport\.width \/ capture\.width/);
  assert.match(ui, /capture\.viewport\.height \/ capture\.height/);
});

test('keeps Stage E controls and source/DOM verification report', () => {
  assert.match(ui, /Run Visual Match/);
  assert.match(ui, /Threshold/);
  assert.match(ui, /screenshotSourceVerified/);
  assert.match(ui, /clickableAncestor/);
  assert.match(ui, /Verification Report/);
});

test('static algorithms remain but are not the active entrypoint', () => {
  assert.match(staticLab, /Stage A: Image Preprocessing Pipeline/);
  assert.match(staticLab, /Stage E: Visual Template Matching/);
  assert.match(staticLab, /Import Real Fixture/);
  const entry = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(entry, /<LiveDomLab \/>/);
  assert.doesNotMatch(entry, /<App \/>|<LabShell \/>/);
});
