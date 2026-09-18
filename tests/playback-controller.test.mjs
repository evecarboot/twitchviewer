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
  const env = { autoplay: true, visible: true, ...cfg };
  const ctl = TwitchPlayback.create(media, {
    isAutoplayEnabled: () => env.autoplay,
    isVisible: () => env.visible,
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
