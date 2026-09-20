/*
 * Unit tests for playback-diagnostics.js — the sanitiser + export builder
 * behind "Export Playback Diagnostics". Pure functions, no browser, no
 * Twitch. The contract: a user exports one JSON file on their Windows + Edge
 * machine and the file can never carry Twitch tokens, signatures, cookies,
 * bearer material, or filesystem paths — while still containing every field
 * needed to diagnose an unmute → refresh loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../playback-diagnostics.js');

/* ---- sanitizeUrl ------------------------------------------------------ */

test('sanitizeUrl strips every query parameter (sig/token cannot survive)', () => {
  const out = d.sanitizeUrl('https://usher.twitch.tv/api/channel/hls/x.m3u8?sig=SECRET_SIG&token=SECRET_TOKEN&p=123');
  assert.equal(out, 'https://usher.twitch.tv/api/channel/hls/x.m3u8');
  assert.doesNotMatch(out, /SECRET/);
  assert.doesNotMatch(out, /[?&]/);
});

test('sanitizeUrl strips hash fragments too', () => {
  assert.equal(d.sanitizeUrl('https://x.test/p#frag=SECRET'), 'https://x.test/p');
});

test('sanitizeUrl preserves safe URLs untouched and handles junk input', () => {
  assert.equal(d.sanitizeUrl('https://a.test/b/c'), 'https://a.test/b/c');
  assert.equal(d.sanitizeUrl(''), '');
  assert.equal(d.sanitizeUrl(null), '');
  assert.equal(d.sanitizeUrl('not a url'), 'not a url');
});

/* ---- redactSensitive -------------------------------------------------- */

test('redactSensitive removes bearer material and secret-looking key=value', () => {
  const out = d.redactSensitive('hls token=SECRET123 Authorization: Bearer SECRET456 cookie_session=SECRET789');
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /<redacted>/);
});

test('redactSensitive sanitizes embedded URLs inside log lines', () => {
  const out = d.redactSensitive('SOURCE loadSource gen=0 url=https://127.0.0.1:3000/twitch/hls/abc/playlist.m3u8?sig=SECRET');
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /playlist\.m3u8/);
  assert.doesNotMatch(out, /sig=/);
});

test('redactSensitive keeps ordinary diagnostic text intact', () => {
  const line = '12:34:56.789 moonmoon volumechange muted=false gesture=true';
  assert.equal(d.redactSensitive(line), line);
});

/* ---- sourceIdentity --------------------------------------------------- */

test('sourceIdentity keeps scheme/host/path but never query material', () => {
  const s = d.sourceIdentity('https://127.0.0.1:3000/twitch/hls/moonmoon/playlist.m3u8?sig=SECRET&token=SECRET');
  assert.equal(s.url, 'https://127.0.0.1:3000/twitch/hls/moonmoon/playlist.m3u8');
  assert.equal(s.tail, 'playlist.m3u8');
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);
});

test('sourceIdentity returns null for empty source', () => {
  assert.equal(d.sourceIdentity(''), null);
  assert.equal(d.sourceIdentity(null), null);
});

/* ---- buildTileSnapshot ------------------------------------------------- */

test('buildTileSnapshot selects the diagnostic fields and sanitizes strings', () => {
  const t = d.buildTileSnapshot({
    channel: 'moonmoon',
    generation: 2,
    currentSrc: 'https://127.0.0.1:3000/twitch/hls/moonmoon/x.m3u8?sig=SECRET',
    state: 'playing',
    muted: false,
    volume: 0.8,
    currentTime: 123.456,
    paused: false,
    ended: false,
    readyState: 4,
    networkState: 2,
    userPaused: false,
    desiredPlaying: true,
    recovery: { ended: 1, network: 0, media: 0 },
  });
  assert.equal(t.channel, 'moonmoon');
  assert.equal(t.generation, 2);
  assert.equal(t.source.tail, 'x.m3u8');
  assert.equal(t.volume, 0.8);
  assert.equal(t.currentTime, 123.5);
  assert.deepEqual(t.recovery, { ended: 1, network: 0, media: 0 });
  assert.doesNotMatch(JSON.stringify(t), /SECRET/);
});

/* ---- buildDiagnosticExport schema ------------------------------------- */

function fullInput() {
  return {
    markedProblem: { at: '2026-01-02T03:04:05.000Z', note: 'user marked', snapshot: 'tile A playing' },
    application: { twitchPlayback: 'proxy', autoplay: true, hideOffline: false, priorityTiles: true, sortByViews: false, tileCount: 3, playbackDebugEnabled: true },
    browser: { userAgent: 'UA Edge/150 Windows', platform: 'Win32', language: 'vi' },
    server: { twitchPlayback: 'proxy', pid: 12345, port: 3000, buildCommit: '874adcb', configured: true, twitchHlsAvailable: false, twitchFilterAds: true },
    page: { origin: 'https://127.0.0.1:3000', path: '/', visibilityState: 'visible', viewport: '1920x1080', userActivation: { isActive: true, hasBeenActive: true } },
    tiles: [
      { channel: 'moonmoon', playerKind: 'video', generation: 0, currentSrc: 'https://127.0.0.1:3000/hls/x.m3u8?sig=SECRET', state: 'playing', muted: true, volume: 1, currentTime: 10, paused: false, ended: false, readyState: 4, networkState: 2, userPaused: false, desiredPlaying: true, recovery: { ended: 0, network: 0, media: 0 } },
      { channel: 'offlinech', playerKind: 'iframe' },
    ],
    history: [
      '12:00:00.000 moonmoon SOURCE mount gen=0 url=https://x/p?sig=SECRET',
      '12:00:01.000 moonmoon volumechange muted=false gesture=true',
    ],
  };
}

test('buildDiagnosticExport produces the stable schema with all sections', () => {
  const e = d.buildDiagnosticExport(fullInput());
  assert.equal(e.diagnosticVersion, 1);
  assert.match(e.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.markedProblem.at, '2026-01-02T03:04:05.000Z');
  assert.equal(e.application.twitchPlayback, 'proxy');
  assert.equal(e.application.playbackDebugEnabled, true);
  assert.equal(e.browser.userAgent, 'UA Edge/150 Windows');
  assert.equal(e.server.pid, 12345);
  assert.equal(e.server.port, 3000);
  assert.equal(e.server.buildCommit, '874adcb');
  assert.equal(e.page.userActivation.isActive, true);
  assert.equal(e.tiles.length, 2);
  assert.equal(e.tiles[0].channel, 'moonmoon');
  assert.equal(e.tiles[1].playerKind, 'iframe');
  assert.equal(e.history.length, 2);
});

test('buildDiagnosticExport cannot leak secrets from any input field', () => {
  const e = d.buildDiagnosticExport(fullInput());
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /SECRET/);
  assert.doesNotMatch(text, /sig=/);
  assert.doesNotMatch(text, /token=/);
});

test('buildDiagnosticExport tolerates missing sections and null markedProblem', () => {
  const e = d.buildDiagnosticExport({ tiles: [], history: [] });
  assert.equal(e.diagnosticVersion, 1);
  assert.equal(e.markedProblem, null);
  assert.deepEqual(e.tiles, []);
  assert.deepEqual(e.history, []);
  assert.equal(e.page.userActivation.isActive, false);
});

test('history is capped at 200 entries', () => {
  const history = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const e = d.buildDiagnosticExport({ history });
  assert.equal(e.history.length, 200);
  assert.equal(e.history[199], 'line 299', 'keeps the most recent entries');
});

test('unpicked fields never enter the export (explicit allowlist)', () => {
  const input = fullInput();
  input.server.env = { SECRET: 'x' };
  input.server.sessions = 'SECRET';
  input.browser.cookies = 'SECRET';
  input.application.oauthToken = 'SECRET';
  const e = d.buildDiagnosticExport(input);
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(e.server.env, undefined);
  assert.equal(e.browser.cookies, undefined);
  assert.equal(e.application.oauthToken, undefined);
});

test('buildTileSnapshot returns null for non-object input', () => {
  assert.equal(d.buildTileSnapshot(null), null);
  assert.equal(d.buildTileSnapshot('x'), null);
});
