/*
 * Regression tests for the per-tile playback state machine
 * (playback-controller.js).
 *
 * These test EXTERNALLY meaningful transitions — user pause vs browser pause,
 * idempotent commands, rejected play() handling, and that audio state never
 * feeds back into playback decisions — not implementation details.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TwitchPlayback = require('../playback-controller.js');

/* A mock HTMLMediaElement implementing the controller's media interface:
   { paused, muted, ended, play() -> Promise, pause(), setMuted(v) } */
function makeMedia() {
  const calls = [];
  const resolvers = [];
  const media = {
    paused: true,
    muted: true,
    ended: false,
    calls,
    play() {
      calls.push('play');
      return new Promise((res, rej) => resolvers.push({ res, rej }));
    },
    pause() {
      calls.push('pause');
      media.paused = true;
    },
    setMuted(v) {
      media.muted = v;
      calls.push(`setMuted:${v}`);
    },
    resolveNextPlay() {
      media.paused = false;
      const r = resolvers.shift();
      if (r) r.res();
    },
    rejectNextPlay(name = 'AbortError', msg = 'play interrupted') {
      const r = resolvers.shift();
      if (r) r.rej(Object.assign(new Error(msg), { name }));
    },
    count(name) {
      return calls.filter((c) => c === name).length;
    },
  };
  return media;
}

function makeCtl(media, cfg = {}) {
  const logs = [];
  const env = { autoplay: true, visible: true, now: 0, ...cfg };
  const ctl = TwitchPlayback.create(media, {
    isAutoplayEnabled: () => env.autoplay,
    isVisible: () => env.visible,
    now: () => env.now,
    log: (l) => logs.push('LOG ' + l),
    debug: (l) => logs.push('DBG ' + l),
  });
  return { ctl, env, logs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('autoplay + visible + already playing → reconcile is a no-op', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  ctl.reconcile('manifest-parsed');
  assert.deepEqual(media.calls, []);
});

test('autoplay + visible + paused → one play()', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.reconcile('mount');
  assert.deepEqual(media.calls, ['play']);
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
});

test('duplicate reconcile PLAY while a play() is pending is idempotent', () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.reconcile('observer-visible');
  ctl.reconcile('manifest-parsed');
  ctl.reconcile('stall-recover');
  assert.equal(media.count('play'), 1);
});

test('desired PAUSE + already paused → no pause command (idempotent)', () => {
  const media = makeMedia(); // paused
  const { ctl, env } = makeCtl(media);
  env.autoplay = false;
  ctl.reconcile('mount');
  assert.deepEqual(media.calls, []);
});

test('desired PAUSE + playing → exactly one pause()', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl, env } = makeCtl(media);
  env.autoplay = false;
  ctl.reconcile('autoplay-off');
  assert.deepEqual(media.calls, ['pause']);
  ctl.reconcile('autoplay-off');
  assert.equal(media.count('pause'), 1);
});

test('a user pause (gesture) sets userPaused and is never auto-resumed', async () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  // browser pauses the element, then fires the event
  media.paused = true;
  const kind = ctl.onPause(true);
  assert.equal(kind, TwitchPlayback.PAUSE_USER);
  assert.equal(ctl.userPaused, true);
  // subsequent reconciles must not play
  ctl.reconcile('manifest-parsed');
  ctl.reconcile('stall-recover');
  ctl.reconcile('observer-visible');
  await tick();
  assert.equal(media.count('play'), 0);
});

test('a browser/external pause is NOT user intent — reconcile resumes', async () => {
  const media = makeMedia();
  media.paused = true;
  const { ctl } = makeCtl(media);
  const kind = ctl.onPause(false); // e.g. Chromium autoplay-policy pause on unmute
  assert.equal(kind, TwitchPlayback.PAUSE_EXTERNAL);
  assert.equal(ctl.userPaused, false);
  // the pause handler re-derived desired=PLAY and issued play()
  assert.equal(media.count('play'), 1);
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
});

test('a controller-issued pause is classified auto even during a user gesture', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl, env } = makeCtl(media);
  env.autoplay = false;
  ctl.reconcile('autoplay-off'); // issues pause(), autoPausePending=1
  assert.deepEqual(media.calls, ['pause']);
  // gesture=true — a click elsewhere on the page must not eat our pause as user
  const kind = ctl.onPause(true);
  assert.equal(kind, TwitchPlayback.PAUSE_AUTO);
  assert.equal(ctl.userPaused, false);
});

test('a pause caused by an app-initiated source reload is not user intent', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.noteSourceReload(); // quality change / ended recovery loadSource
  media.paused = true;
  const kind = ctl.onPause(true); // even if a gesture happens to be active
  assert.equal(kind, TwitchPlayback.PAUSE_RELOAD);
  assert.equal(ctl.userPaused, false);
  await tick();
  assert.equal(media.count('play'), 1); // reload resume, not a fight
});

test('audible play() rejected NotAllowedError → re-mute + retry, no loop', async () => {
  const media = makeMedia();
  media.muted = false; // programmatically unmuted without activation
  const { ctl } = makeCtl(media);
  ctl.reconcile('mount');
  assert.deepEqual(media.calls, ['play']);
  media.rejectNextPlay('NotAllowedError', 'play() failed because the user did not interact');
  await tick();
  // controller recovered to baseline muted playback and retried
  assert.deepEqual(media.calls, ['play', 'setMuted:true', 'play']);
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
  assert.equal(ctl.userMuted, undefined); // programmatic re-mute ≠ user choice
});

test('play() AbortError retries are bounded — no retry storm', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.reconcile('mount');
  // keep aborting every play — simulates a persistent pauser
  for (let i = 0; i < 10; i++) {
    media.rejectNextPlay('AbortError');
    await tick();
  }
  // 1 initial + MAX_CONSECUTIVE_PLAY_REJECTIONS retries, then it gives up
  assert.equal(media.count('play'), 5);
  await tick();
  assert.equal(media.count('play'), 5); // still no more
});

test('a user pause landing while play() is in flight still wins', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.reconcile('mount'); // play() pending
  assert.deepEqual(media.calls, ['play']);
  // user pauses mid-flight — the old code swallowed this via _reconcilePlaying
  const kind = ctl.onPause(true);
  assert.equal(kind, TwitchPlayback.PAUSE_USER);
  assert.equal(ctl.userPaused, true);
  // the in-flight play resolves late; settle re-derives and pauses again
  media.paused = false;
  media.resolveNextPlay();
  await tick();
  assert.deepEqual(media.calls, ['play', 'pause']);
});

test('a user play clears userPaused; an external play does not', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.userPaused = true;
  // external play (e.g. autoplay attr re-firing after a reload) must not
  // override a user pause — reconcile re-pauses it
  media.paused = false;
  const kind1 = ctl.onPlay(false);
  assert.equal(kind1, TwitchPlayback.PLAY_EXTERNAL);
  assert.equal(ctl.userPaused, true);
  assert.deepEqual(media.calls, ['pause']);
  // a real user play clears it
  media.paused = false;
  const kind2 = ctl.onPlay(true);
  assert.equal(kind2, TwitchPlayback.PLAY_USER);
  assert.equal(ctl.userPaused, false);
});

test('visibility off→on produces exactly one pause then one play', async () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl, env } = makeCtl(media);
  env.visible = false;
  ctl.reconcile('observer-offscreen');
  assert.deepEqual(media.calls, ['pause']);
  env.visible = true;
  ctl.reconcile('observer-visible');
  assert.equal(media.count('play'), 1);
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
});

test('a user pause survives offscreen/onscreen transitions', () => {
  const media = makeMedia();
  media.paused = true;
  const { ctl, env } = makeCtl(media);
  ctl.onPause(true); // user paused
  env.visible = false;
  ctl.reconcile('observer-offscreen');
  env.visible = true;
  ctl.reconcile('observer-visible');
  ctl.reconcile('manifest-parsed');
  assert.equal(media.count('play'), 0);
});

test('mute/unmute is audio intent only — never changes playback decisions', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  ctl.onVolumeChange(true); // user unmutes
  media.muted = false;
  ctl.onVolumeChange(true);
  assert.equal(ctl.userMuted, false);
  assert.deepEqual(media.calls, []); // no play/pause side-effects
  media.muted = true;
  ctl.onVolumeChange(true);
  assert.equal(ctl.userMuted, true);
  assert.deepEqual(media.calls, []);
});

test('programmatic (non-gesture) volumechange is not recorded as user audio intent', () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  media.muted = false;
  ctl.onVolumeChange(false); // e.g. a script set video.muted
  assert.equal(ctl.userMuted, undefined);
});

test('stall recovery while user-paused does NOT resume; while playing is a no-op', () => {
  const media = makeMedia();
  media.paused = true;
  const { ctl } = makeCtl(media);
  ctl.onPause(true); // user paused
  ctl.reconcile('stall-recover');
  assert.equal(media.count('play'), 0);
  // same stall while playing — nothing to do
  media.paused = false;
  const media2 = makeMedia();
  media2.paused = false;
  const { ctl: ctl2 } = makeCtl(media2);
  ctl2.reconcile('stall-recover');
  assert.deepEqual(media2.calls, []);
});

test('external pause while autoplay disabled stays paused', () => {
  const media = makeMedia();
  media.paused = true;
  const { ctl, env } = makeCtl(media);
  env.autoplay = false;
  ctl.onPause(false);
  assert.equal(media.count('play'), 0);
});

test('forcePlay bypasses userPaused', async () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.userPaused = true;
  ctl.reconcile('recovery', { forcePlay: true });
  assert.equal(media.count('play'), 1);
  media.resolveNextPlay();
  await tick();
});

/* ---------- isUserGesture: element-scoped user-activation classification ---------- */

const isUserGesture = TwitchPlayback.isUserGesture;
const VIDEO = { tag: 'VIDEO' };
const BODY = { tag: 'BODY' };
const HTML = { tag: 'HTML' };
const BUTTON = { tag: 'BUTTON' };
const LOOSE = [BODY, HTML];

test('isUserGesture: no UserActivation API → legacy true', () => {
  assert.equal(
    isUserGesture({ ua: undefined, activeElement: BUTTON, video: VIDEO, looseElements: LOOSE, lastKeydownAt: -1e9, now: 0 }),
    true
  );
});

test('isUserGesture: no activation → false', () => {
  assert.equal(
    isUserGesture({ ua: { isActive: false }, activeElement: VIDEO, video: VIDEO, looseElements: LOOSE, lastKeydownAt: 0, now: 0 }),
    false
  );
});

test('isUserGesture: activation + video focused → true (native-control click)', () => {
  assert.equal(
    isUserGesture({ ua: { isActive: true }, activeElement: VIDEO, video: VIDEO, looseElements: LOOSE, lastKeydownAt: -1e9, now: 0 }),
    true
  );
});

test('isUserGesture: activation + no specific focus (BODY) → true', () => {
  assert.equal(
    isUserGesture({ ua: { isActive: true }, activeElement: BODY, video: VIDEO, looseElements: LOOSE, lastKeydownAt: -1e9, now: 0 }),
    true
  );
});

test('isUserGesture: activation + ANOTHER element focused → false (the frame-wide fix)', () => {
  // user clicked a toolbar button while the video stall-paused — NOT a user pause
  assert.equal(
    isUserGesture({ ua: { isActive: true }, activeElement: BUTTON, video: VIDEO, looseElements: LOOSE, lastKeydownAt: -1e9, now: 5000 }),
    false
  );
});

test('isUserGesture: activation + other element focused + fresh keydown → true (keyboard media control)', () => {
  assert.equal(
    isUserGesture({ ua: { isActive: true }, activeElement: BUTTON, video: VIDEO, looseElements: LOOSE, lastKeydownAt: 4900, now: 5000 }),
    true
  );
});

test('isUserGesture: activation + other element focused + stale keydown → false', () => {
  assert.equal(
    isUserGesture({ ua: { isActive: true }, activeElement: BUTTON, video: VIDEO, looseElements: LOOSE, lastKeydownAt: 4000, now: 5000 }),
    false
  );
});

test('end-to-end: a pause while another element is focused does not stick as user pause', () => {
  const media = makeMedia();
  media.paused = true;
  const { ctl } = makeCtl(media);
  // stall pause while the user was clicking a toolbar button
  const gesture = isUserGesture({
    ua: { isActive: true },
    activeElement: BUTTON,
    video: VIDEO,
    looseElements: LOOSE,
    lastKeydownAt: -1e9,
    now: 100,
  });
  const kind = ctl.onPause(gesture);
  assert.equal(kind, TwitchPlayback.PAUSE_EXTERNAL);
  assert.equal(ctl.userPaused, false);
  assert.equal(media.count('play'), 1); // resumed, not stuck
});

/* ---------- twitchEmbedUserUnmuted: iframe audio-choice guard ---------- */

const twitchEmbedUserUnmuted = TwitchPlayback.twitchEmbedUserUnmuted;

test('twitchEmbedUserUnmuted: muted player → false (automation may re-assert muted)', () => {
  assert.equal(twitchEmbedUserUnmuted({ getMuted: () => true }), false);
});

test('twitchEmbedUserUnmuted: unmuted player → true (automation must not re-mute)', () => {
  assert.equal(twitchEmbedUserUnmuted({ getMuted: () => false }), true);
});

test('twitchEmbedUserUnmuted: missing player or API → false (safe default)', () => {
  assert.equal(twitchEmbedUserUnmuted(null), false);
  assert.equal(twitchEmbedUserUnmuted({}), false);
  assert.equal(twitchEmbedUserUnmuted({ getMuted: 'nope' }), false);
});

test('twitchEmbedUserUnmuted: throwing getMuted → false (fail safe)', () => {
  assert.equal(
    twitchEmbedUserUnmuted({
      getMuted: () => {
        throw new Error('dead');
      },
    }),
    false
  );
});

test('user pause then external play → controller re-pauses (autoplay attr on reload)', () => {
  const media = makeMedia();
  const { ctl } = makeCtl(media);
  ctl.onPause(true); // user paused
  ctl.noteSourceReload();
  // the element's autoplay attribute re-fires play on re-attach
  media.paused = false;
  ctl.onPlay(false);
  assert.equal(ctl.userPaused, true);
  assert.deepEqual(media.calls, ['pause']);
});

/* --- Canonical per-cell Twitch playing state (channel-points tracking) ---
   syncPointsPlaying() must count a tile only when it is REALLY playing.
   Native tiles prove it via the video element; cross-origin Twitch.Player
   iframe tiles prove it via the event-confirmed _twitchPlaying flag. */

function makeCell({ video, player, playingFlag } = {}) {
  return {
    querySelector: () => video || null,
    _twitchPlayer: player || null,
    _twitchPlaying: playingFlag,
  };
}

test('twitchCellIsPlaying: native video playing → true', () => {
  const cell = makeCell({ video: { paused: false, ended: false } });
  assert.equal(TwitchPlayback.twitchCellIsPlaying(cell), true);
});

test('twitchCellIsPlaying: native video paused → false', () => {
  const cell = makeCell({ video: { paused: true, ended: false } });
  assert.equal(TwitchPlayback.twitchCellIsPlaying(cell), false);
});

test('twitchCellIsPlaying: native video ended → false', () => {
  const cell = makeCell({ video: { paused: false, ended: true } });
  assert.equal(TwitchPlayback.twitchCellIsPlaying(cell), false);
});

test('twitchCellIsPlaying: iframe player + confirmed PLAYING flag → true', () => {
  const cell = makeCell({ player: { getMuted: () => true }, playingFlag: true });
  assert.equal(TwitchPlayback.twitchCellIsPlaying(cell), true);
});

test('twitchCellIsPlaying: iframe player mounted but not confirmed playing → false', () => {
  // READY / PLAY / ONLINE / PLAYBACK_BLOCKED states — mounted, not playing.
  for (const flag of [false, undefined]) {
    const cell = makeCell({ player: { getMuted: () => true }, playingFlag: flag });
    assert.equal(TwitchPlayback.twitchCellIsPlaying(cell), false);
  }
});

test('twitchCellIsPlaying: iframe element present but no player → false', () => {
  assert.equal(TwitchPlayback.twitchCellIsPlaying(makeCell()), false);
});

test('twitchCellIsPlaying: missing cell → false (fail safe)', () => {
  assert.equal(TwitchPlayback.twitchCellIsPlaying(null), false);
  assert.equal(TwitchPlayback.twitchCellIsPlaying(undefined), false);
});

/* --- Twitch.Player autoplay retry schedule --- */

test('TWITCH_IFRAME_PLAY_RETRY_DELAYS: bounded, increasing, covers the init race', () => {
  const d = TwitchPlayback.TWITCH_IFRAME_PLAY_RETRY_DELAYS;
  assert.ok(Array.isArray(d) && d.length > 0 && d.length <= 12, 'bounded retry count');
  assert.ok(d.every((ms) => Number.isFinite(ms) && ms > 0), 'all delays positive');
  for (let i = 1; i < d.length; i++) {
    assert.ok(d[i] > d[i - 1], 'delays strictly increase');
  }
  assert.ok(d[0] < 1000, 'first nudge lands inside Twitch init window');
  assert.ok(d[d.length - 1] <= 60000, 'schedule stays bounded — no unlimited loop');
});

/* --- Read-only iframe cell diagnostics (Edge/Windows bug-report path) --- */

function makeDiagCell({ player, playingFlag, iframe } = {}) {
  return {
    dataset: { channelKey: 't:somechan' },
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    querySelector: () => iframe || null,
    _twitchPlayer: player || null,
    _twitchPlaying: playingFlag,
  };
}

test('twitchIframeCellDiagnostics: full player state reported read-only', () => {
  const calls = [];
  const player = {
    getMuted: () => { calls.push('getMuted'); return true; },
    isPaused: () => { calls.push('isPaused'); return false; },
    getEnded: () => { calls.push('getEnded'); return false; },
    getQualities: () => [{}, {}, {}],
  };
  const iframe = {
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    getAttribute: (n) => (n === 'allow' ? 'autoplay; fullscreen' : null),
  };
  const cell = makeDiagCell({ player, playingFlag: true, iframe });
  cell._twitchReadyAt = 111;
  cell._twitchPlayingAt = 222;
  const d = TwitchPlayback.twitchIframeCellDiagnostics(cell);
  assert.equal(d.channel, 'somechan');
  assert.equal(d.cellSize.w, 640);
  assert.equal(d.iframe.allowAutoplay, true);
  assert.equal(d.player.muted, true);
  assert.equal(d.player.paused, false);
  assert.equal(d.player.qualities, 3);
  assert.equal(d.player.readyAt, 111);
  assert.equal(d.player.playingConfirmed, true);
  assert.equal(d.player.playingAt, 222);
  assert.equal(cell._twitchPlaying, true, 'diagnostics must not mutate cell state');
  assert.equal(typeof cell._twitchPlayer, 'object', 'player untouched');
});

test('twitchIframeCellDiagnostics: missing player methods yield null, never throw', () => {
  const cell = makeDiagCell({ player: {} });
  const d = TwitchPlayback.twitchIframeCellDiagnostics(cell);
  assert.equal(d.player.exists, true);
  assert.equal(d.player.muted, null);
  assert.equal(d.player.paused, null);
  assert.equal(d.player.ended, null);
  assert.equal(d.player.qualities, null);
  assert.equal(d.player.retryCount, 0);
});

test('twitchIframeCellDiagnostics: throwing getters → null, still no throw', () => {
  const cell = makeDiagCell({
    player: {
      getMuted: () => { throw new Error('dead embed'); },
      isPaused: () => { throw new Error('dead embed'); },
    },
    playingFlag: false,
  });
  const d = TwitchPlayback.twitchIframeCellDiagnostics(cell);
  assert.equal(d.player.muted, null);
  assert.equal(d.player.paused, null);
  assert.equal(d.player.playingConfirmed, false);
});

test('twitchIframeCellDiagnostics: no player → player null, missing cell → all null', () => {
  const d1 = TwitchPlayback.twitchIframeCellDiagnostics(makeDiagCell());
  assert.equal(d1.player, null);
  assert.equal(d1.channel, 'somechan');
  const d2 = TwitchPlayback.twitchIframeCellDiagnostics(null);
  assert.deepEqual(d2, { channel: null, cellSize: null, iframe: null, player: null });
});

/* --- Twitch embed compliance constants --- */

test('TWITCH_IFRAME_MIN_* constants satisfy Twitch embed requirements', () => {
  assert.equal(TwitchPlayback.TWITCH_IFRAME_MIN_W, 400);
  assert.equal(TwitchPlayback.TWITCH_IFRAME_MIN_H, 300);
  assert.ok(TwitchPlayback.TWITCH_IFRAME_HEADER_H > 0);
  assert.equal(
    TwitchPlayback.TWITCH_IFRAME_MIN_CELL_W,
    TwitchPlayback.TWITCH_IFRAME_MIN_W
  );
  assert.equal(
    TwitchPlayback.TWITCH_IFRAME_MIN_CELL_H,
    TwitchPlayback.TWITCH_IFRAME_MIN_H + TwitchPlayback.TWITCH_IFRAME_HEADER_H,
    'cell must hold a >=300px embed plus the control bar'
  );
});

/* --- Read-only style-visibility / occlusion diagnostics --- */

function makeVisCell({ iframe, overlays = {} } = {}) {
  return {
    dataset: { channelKey: 't:somechan' },
    querySelector: (sel) =>
      sel.includes('player.twitch.tv') ? iframe : overlays[sel] || null,
  };
}

function makeIframeRect(rect, { above = [] } = {}) {
  return {
    tagName: 'IFRAME',
    parentElement: null,
    getBoundingClientRect: () => rect,
    contains: () => false,
    _above: above,
  };
}

test('twitchIframeVisibilityDiagnostics: no iframe → null report, never throws', () => {
  const d = TwitchPlayback.twitchIframeVisibilityDiagnostics(makeVisCell());
  assert.equal(d.channel, 'somechan');
  assert.equal(d.iframe, null);
  assert.equal(TwitchPlayback.twitchIframeVisibilityDiagnostics(null).iframe, null);
});

test('twitchIframeVisibilityDiagnostics: overlay elements are reported above the iframe', () => {
  const rect = { left: 0, top: 0, right: 527, bottom: 361, width: 527, height: 361, x: 0, y: 0 };
  const dragStrip = { tagName: 'DIV', className: 'cell-drag-handle' };
  const iframe = makeIframeRect(rect);
  // elementsFromPoint at right-center returns the drag strip on top of the iframe.
  const efp = (x, y) => (x > rect.right - 30 ? [dragStrip, iframe] : [iframe]);
  const d = TwitchPlayback.twitchIframeVisibilityDiagnostics(
    makeVisCell({ iframe }),
    efp
  );
  assert.equal(d.iframe.meetsMinSize, true);
  assert.equal(d.occlusion.center.iframeHit, true);
  assert.equal(d.occlusion.center.aboveIframe.length, 0);
  assert.equal(d.occlusion.rightCenter.iframeHit, true);
  assert.deepEqual(d.occlusion.rightCenter.aboveIframe, ['div.cell-drag-handle']);
});

test('twitchIframeVisibilityDiagnostics: missing elementsFromPoint → occlusion null', () => {
  const rect = { left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300, x: 0, y: 0 };
  const d = TwitchPlayback.twitchIframeVisibilityDiagnostics(
    makeVisCell({ iframe: makeIframeRect(rect) }),
    null
  );
  assert.equal(d.occlusion, null);
});

/* --- createRateLimiter: sliding-window budget for recovery actions --- */

test('createRateLimiter: allows up to max actions within the window', () => {
  let t = 0;
  const allow = TwitchPlayback.createRateLimiter(3, 1000, () => t);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), false, 'fourth action within the window is denied');
  assert.equal(allow(), false, 'denial does not consume budget');
});

test('createRateLimiter: window self-heals — full budget after quiet period', () => {
  let t = 0;
  const allow = TwitchPlayback.createRateLimiter(2, 1000, () => t);
  allow();
  allow();
  assert.equal(allow(), false);
  t = 1001;
  assert.equal(allow(), true, 'budget replenishes once entries age out');
  assert.equal(allow(), true);
  assert.equal(allow(), false);
});

test('createRateLimiter: sliding window expires oldest entries first', () => {
  let t = 0;
  const allow = TwitchPlayback.createRateLimiter(2, 1000, () => t);
  allow(); // t=0
  t = 900;
  allow(); // t=900 — window holds [0, 900]
  assert.equal(allow(), false);
  t = 1100; // t=0 aged out; window holds [900]
  assert.equal(allow(), true);
});

test('createRateLimiter: a recovery loop is bounded — repeated requests stop', () => {
  // Simulates the 'ended'→loadSource loop: each reload schedules the next
  // 'ended' if the playlist keeps ending. The limiter must turn an infinite
  // loop into a bounded burst.
  let t = 0;
  const allow = TwitchPlayback.createRateLimiter(3, 120000, () => t);
  let reloads = 0;
  for (let i = 0; i < 20; i++) {
    if (allow()) reloads++;
    t += 2000; // each cycle is ~2s — stays well inside the window
  }
  assert.equal(reloads, 3, 'no more than max reloads inside the window');
});

/* --- Chromium unmute-pause intervention (PAUSE_UNMUTE) ---
   On builds/configs where the unmute gesture does not satisfy autoplay
   policy, Chromium pauses the element right after the user's unmute
   ("Unmuting failed and the element was paused instead"). That pause must
   not latch userPaused — the user's intent was to keep watching audibly.
   The controller replays it while the click's activation is still live. */

test('unmute gesture then pause → unmute intervention, not user pause; controller replays', async () => {
  const media = makeMedia();
  media.paused = false; // playing muted
  const { ctl } = makeCtl(media);
  // user clicks the native unmute control → volumechange(unmuted, gesture)
  media.muted = false;
  ctl.onVolumeChange(true);
  assert.equal(ctl.userMuted, false);
  // Chromium's intervention then pauses the element (still inside the gesture)
  media.paused = true;
  const kind = ctl.onPause(true);
  assert.equal(kind, TwitchPlayback.PAUSE_UNMUTE);
  assert.equal(ctl.userPaused, false, 'unmute-pause must not latch userPaused');
  // reconcile should have issued a play() to resume (audible play allowed —
  // the click's activation is still active)
  assert.equal(media.count('play'), 1);
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
});

test('user pause long after unmute → still a real user pause', async () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl, env } = makeCtl(media);
  media.muted = false;
  ctl.onVolumeChange(true);
  env.now = 5000; // well past the unmute window
  media.paused = true;
  const kind = ctl.onPause(true);
  assert.equal(kind, TwitchPlayback.PAUSE_USER);
  assert.equal(ctl.userPaused, true);
  assert.equal(media.count('play'), 0, 'a real user pause is never auto-resumed');
});

test('pause with gesture but no preceding unmute → user pause', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  media.paused = true;
  assert.equal(ctl.onPause(true), TwitchPlayback.PAUSE_USER);
  assert.equal(ctl.userPaused, true);
});

test('unmute gesture then pause while MUTED (re-muted in between) → user pause', () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  media.muted = false;
  ctl.onVolumeChange(true);
  media.muted = true; // user re-muted before the pause
  media.paused = true;
  assert.equal(ctl.onPause(true), TwitchPlayback.PAUSE_USER);
});

test('unmute-pause replay is bounded: rejected audible play re-mutes once, no loop', async () => {
  const media = makeMedia();
  media.paused = false;
  const { ctl } = makeCtl(media);
  media.muted = false;
  ctl.onVolumeChange(true);
  media.paused = true;
  ctl.onPause(true);
  assert.equal(media.count('play'), 1);
  // audible play rejected (no activation) → controller re-mutes and replays muted
  media.rejectNextPlay('NotAllowedError', 'play() failed because the user didn\'t interact');
  await tick();
  assert.ok(media.calls.includes('setMuted:true'), 're-mutes to recover');
  assert.equal(media.count('play'), 2, 'one muted retry');
  media.resolveNextPlay();
  await tick();
  assert.equal(media.paused, false);
  // volumechange from the programmatic re-mute has no gesture → intent preserved
  ctl.onVolumeChange(false);
  assert.equal(ctl.userMuted, false, 'programmatic re-mute does not overwrite user audio intent');
});

/* --- createConsecutiveLimiter: fatal NETWORK_ERROR restart budget ---
   Semantics: each failure consumes one slot; a success (LEVEL_LOADED) resets
   the streak so occasional transient errors never accumulate into a false
   "persistent failure". */

test('createConsecutiveLimiter: allows max consecutive, then denies', () => {
  const lim = TwitchPlayback.createConsecutiveLimiter(8);
  for (let i = 0; i < 8; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false, '9th consecutive failure is denied');
  assert.equal(lim.count, 9, 'count reflects attempts');
});

test('createConsecutiveLimiter: success reset clears the streak (fatal,fatal,loaded,fatal → count 1)', () => {
  const lim = TwitchPlayback.createConsecutiveLimiter(3);
  lim.tryAcquire(); // fatal 1
  lim.tryAcquire(); // fatal 2
  lim.reset(); // LEVEL_LOADED — stream is healthy again
  assert.equal(lim.count, 0);
  lim.tryAcquire(); // fatal 3 — a NEW streak, not exhaustion
  assert.equal(lim.tryAcquire(), true, 'second of the new streak allowed');
  lim.tryAcquire();
  assert.equal(lim.tryAcquire(), false, 'only now is the budget exhausted');
});

test('createConsecutiveLimiter: occasional fatals never falsely exhaust', () => {
  const lim = TwitchPlayback.createConsecutiveLimiter(8);
  // 50 fatal errors spread over a long stream, each followed by a successful
  // playlist load — must never hit the limit.
  for (let i = 0; i < 50; i++) {
    assert.equal(lim.tryAcquire(), true);
    lim.reset();
  }
});

test('createRateLimiter: used() introspection reflects consumed budget', () => {
  let t = 0;
  const allow = TwitchPlayback.createRateLimiter(3, 1000, () => t);
  assert.equal(allow.used(), 0);
  allow();
  allow();
  assert.equal(allow.used(), 2, 'two slots consumed');
  t = 1500;
  assert.equal(allow.used(), 0, 'expired entries no longer count');
});
