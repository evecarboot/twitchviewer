/*
 * Per-tile playback state machine.
 *
 * ONE authority decides whether a tile's <video> should be playing:
 *   desired = forcePlay || (autoplay && visible && !userPaused && !ended)
 *
 * Audio state (muted/volume) is tracked separately from playback state —
 * unmuting must never be treated as "play", and muting never as "pause".
 *
 * Pause/play events are classified by PROVENANCE, not guessed by flags:
 *   - auto   : a pause() issued by this controller (tracked by counter)
 *   - reload : a pause caused by a source reload we initiated (loadSource etc.)
 *   - ended  : pause accompanying 'ended'
 *   - user   : a pause that happened during a real user gesture
 *              (navigator.userActivation.isActive — covers native-controls
 *               clicks, which do not emit DOM events outside the shadow root)
 *   - external: everything else — browser autoplay-policy pauses, underrun
 *               pauses, Chromium visibility auto-pauses. NOT user intent.
 *
 * Only 'user' pauses set userPaused. Everything else is re-evaluated against
 * the desired state, so browser-caused pauses can no longer brick a tile.
 *
 * Commands are idempotent: duplicate reconcile→PLAY while a play() is in
 * flight is a no-op, and settle handlers re-derive state so a user pause
 * landing mid-flight still wins.
 *
 * This file is loadable both as a classic <script> (window.TwitchPlayback)
 * and as a Node module (tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TwitchPlayback = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const PAUSE_USER = 'user';
  const PAUSE_AUTO = 'auto';
  const PAUSE_RELOAD = 'reload';
  const PAUSE_ENDED = 'ended';
  const PAUSE_EXTERNAL = 'external';

  const PLAY_AUTO = 'auto';
  const PLAY_USER = 'user';
  const PLAY_EXTERNAL = 'external';

  /** Safety cap on consecutive rejected play() retries. A rejection triggers
   *  one re-derivation; if every attempt keeps getting aborted (a persistent
   *  pauser), we stop rather than storm. Any successful play or new external
   *  reconcile reason resets the counter. */
  const MAX_CONSECUTIVE_PLAY_REJECTIONS = 4;

  /**
   * @param {object} media — adapter over the media element:
   *   { paused, muted, ended, play() -> Promise, pause(), setMuted(bool) }
   * @param {object} hooks:
   *   isAutoplayEnabled(): boolean — global autoplay switch
   *   isVisible(): boolean — canonical "eligible for auto playback" check
   *   log(line): always-on concise log (state transitions, warnings)
   *   debug(line): verbose diagnostics (event classification details)
   */
  function create(media, hooks) {
    const isAutoplayEnabled =
      (hooks && hooks.isAutoplayEnabled) || (() => true);
    const isVisible = (hooks && hooks.isVisible) || (() => true);
    const log = (hooks && hooks.log) || (() => {});
    const debug = (hooks && hooks.debug) || (() => {});

    const ctl = {
      media,
      /** User pressed pause via media controls. Cleared by a user play. */
      userPaused: false,
      /** Last audio choice made through a real user gesture (informational —
       *  audio intent never feeds the playback decision). */
      userMuted: undefined,
      /** A reconcile-issued play() promise is in flight. */
      playPending: false,
      /** Count of controller-issued pause() calls whose 'pause' events have
       *  not yet been observed. */
      autoPausePending: 0,
      /** A pause event caused by an app-initiated source reload is expected. */
      reloadPausePending: false,
      /** Consecutive play() rejections — bounded retries, reset on success. */
      rejectedPlays: 0,
      desiredPlaying,
      reconcile,
      onPause,
      onPlay,
      onVolumeChange,
      onEnded,
      noteSourceReload,
      _classifyPause: classifyPause,
    };

    function desiredPlaying() {
      return Boolean(
        isAutoplayEnabled() && isVisible() && !ctl.userPaused && !media.ended
      );
    }

    /** Re-derive desired state and issue at most one idempotent command.
     *  Safe to call from any event, any number of times. */
    function reconcile(reason, opts) {
      if (!media) return;
      const forcePlay = Boolean(opts && opts.forcePlay);
      const want = forcePlay || desiredPlaying();
      let acted = 'no-op';

      if (want) {
        if (!media.paused) {
          /* already playing */
        } else if (ctl.playPending) {
          acted = 'no-op(play-pending)';
        } else {
          ctl.playPending = true;
          acted = 'play';
          issuePlay();
        }
      } else if (!media.paused) {
        ctl.autoPausePending++;
        acted = 'pause';
        try {
          media.pause();
        } catch {
          ctl.autoPausePending--;
        }
      }

      debug(
        `desired=${want ? 'PLAY' : 'PAUSE'} ${acted} reason=${reason} ` +
          `paused=${media.paused} muted=${media.muted} ended=${media.ended} ` +
          `autoplay=${isAutoplayEnabled()} visible=${isVisible()} ` +
          `userPaused=${ctl.userPaused} playPending=${ctl.playPending}`
      );
    }

    function issuePlay() {
      let settled = false;
      let p;
      try {
        p = media.play();
      } catch (e) {
        settlePlay(e);
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then(() => settlePlay(null), (e) => settlePlay(e));
      } else {
        settlePlay(null);
      }
      function settlePlay(err) {
        if (settled) return;
        settled = true;
        ctl.playPending = false;
        if (!err) {
          ctl.rejectedPlays = 0;
          ctl.reconcile('play-resolved');
          return;
        }
        ctl.rejectedPlays++;
        debug(
          `play() rejected ${err && err.name}: ${err && err.message} ` +
            `(consecutive=${ctl.rejectedPlays})`
        );
        /* Audible play blocked by autoplay policy — recover to the baseline
           muted-playing state once. Programmatic re-mute is NOT a user audio
           choice (volumechange arrives without activation, so userMuted is
           untouched). A muted play() is always allowed, so this cannot loop. */
        if (err && err.name === 'NotAllowedError' && !media.muted) {
          log('audible play blocked by autoplay policy — re-muting to resume');
          try {
            media.setMuted(true);
          } catch {
            /* ignore */
          }
          ctl.rejectedPlays = 0;
          ctl.reconcile('unblock-remute');
          return;
        }
        if (ctl.rejectedPlays <= MAX_CONSECUTIVE_PLAY_REJECTIONS) {
          ctl.reconcile('play-rejected');
        } else {
          log('play() repeatedly rejected — giving up until next trigger');
        }
      }
    }

    /** Classify a 'pause' event. `gesture` = a real user activation was
     *  active when the event fired (navigator.userActivation.isActive). */
    function classifyPause(gesture) {
      /* Order matters: causes we can positively identify (our own commands,
         our reloads, ended) must win over the gesture heuristic — a user
         click elsewhere on the page sets isActive frame-wide, and an
         unrelated app/browser pause must not be eaten as user intent. */
      if (ctl.autoPausePending > 0) return PAUSE_AUTO;
      if (ctl.reloadPausePending) return PAUSE_RELOAD;
      if (media.ended) return PAUSE_ENDED;
      if (gesture) return PAUSE_USER;
      return PAUSE_EXTERNAL;
    }

    function onPause(gesture) {
      const kind = classifyPause(gesture);
      if (kind === PAUSE_AUTO) ctl.autoPausePending--;
      else if (kind === PAUSE_RELOAD) ctl.reloadPausePending = false;
      else if (kind === PAUSE_USER) ctl.userPaused = true;
      debug(`pause kind=${kind} gesture=${!!gesture}`);
      /* Re-derive: an external/browser pause must not stand when the desired
         state is PLAY (replaces the role Chromium's muted-autoplay resume
         used to play, but owned by the app). A user pause flips desired to
         PAUSE — the reconcile is then a no-op that also cancels nothing. */
      ctl.reconcile(`pause-${kind}`);
      return kind;
    }

    function onPlay(gesture) {
      let kind;
      if (ctl.playPending) kind = PLAY_AUTO;
      else if (gesture) {
        ctl.userPaused = false;
        kind = PLAY_USER;
      } else {
        kind = PLAY_EXTERNAL;
      }
      /* Any real play ends a reload window. */
      ctl.reloadPausePending = false;
      debug(`play kind=${kind} gesture=${!!gesture}`);
      /* External plays (e.g. the element's autoplay attribute re-firing after
         a source reload) must not override a user pause — reconcile enforces
         desired and will re-pause if needed. */
      ctl.reconcile(`play-${kind}`);
      return kind;
    }

    /** volumechange. Audio state is intentionally separate from playback
     *  state — this only records explicit user audio intent. */
    function onVolumeChange(gesture) {
      if (gesture) ctl.userMuted = media.muted;
      debug(`volumechange muted=${media.muted} gesture=${!!gesture}`);
    }

    function onEnded() {
      ctl.reconcile('ended');
    }

    /** Call immediately before any app-initiated source reload (loadSource,
     *  recoverMediaError, src swap) so the resulting 'pause' event is not
     *  mistaken for a user pause. */
    function noteSourceReload() {
      ctl.reloadPausePending = true;
    }

    return ctl;
  }

  /**
   * Decide whether a media event came from a real user gesture targeting
   * `video`. navigator.userActivation.isActive is the only reliable activation
   * signal for native media-controls interactions — control clicks never
   * produce DOM events outside the UA shadow root — but it is frame-wide.
   * Scope it to the element:
   *   - the video element itself is focused (verified in Chrome: control
   *     clicks focus the <video>, the focus event precedes the pause event), or
   *   - no specific element is focused (browsers that never focus <video>
   *     leave BODY — preserves the legacy behavior there), or
   *   - a keydown just happened (keyboard media control — space/k or hardware
   *     play/pause keys — does not move focus to the video).
   * A pause while ANOTHER element (toolbar button, input) holds focus is NOT
   * a user pause on this video — this is what prevents a coincidental page
   * click from turning a browser/HLS pause into a stuck "user" pause.
   *
   * Pure function — browser globals are injected by the caller.
   */
  function isUserGesture(opts) {
    const ua = opts.ua;
    if (!ua || typeof ua.isActive !== 'boolean') return true; /* no API → legacy */
    if (!ua.isActive) return false;
    if (
      opts.activeElement === opts.video ||
      (opts.looseElements && opts.looseElements.includes(opts.activeElement))
    ) {
      return true;
    }
    const keyWindow = opts.keyWindowMs == null ? 400 : opts.keyWindowMs;
    return opts.now - opts.lastKeydownAt < keyWindow;
  }

  /**
   * Twitch.Player embeds: has the user explicitly unmuted? Used by the iframe
   * play-retry and ONLINE-recovery paths so automation never re-mutes a
   * user-chosen audible player. Returns false when the player or API is
   * missing — i.e. "still muted" is the safe assumption for automation.
   */
  function twitchEmbedUserUnmuted(player) {
    try {
      return Boolean(
        player && typeof player.getMuted === 'function' && !player.getMuted()
      );
    } catch {
      return false;
    }
  }

  /**
   * Canonical per-cell answer to "is this Twitch tile ACTUALLY playing right
   * now?" — mode-independent so channel-points tracking works the same for
   * every playback mode.
   *
   * Native proxy/HLS tiles carry a same-origin <video class="cell-video">:
   * playing means !paused && !ended. Twitch.Player iframe tiles are
   * cross-origin (no reachable video element), so they prove playback with the
   * event-confirmed _twitchPlaying flag — only the Twitch.Player PLAYING event
   * sets it; READY, PLAY, ONLINE and mere iframe presence never count.
   */
  function twitchCellIsPlaying(cell) {
    if (!cell) return false;
    const video =
      typeof cell.querySelector === 'function'
        ? cell.querySelector('video.cell-video')
        : null;
    if (video) return !video.paused && !video.ended;
    if (cell._twitchPlayer) return cell._twitchPlaying === true;
    return false;
  }

  /**
   * Bounded retry schedule for Twitch.Player autoplay nudges. READY-time
   * play() can silently lose a race with the embed's postMessage handshake, so
   * callers re-nudge on this schedule and stop the moment PLAYING fires —
   * bounded, never an unlimited setMuted/play loop. The two late nudges (25s,
   * 40s) cover slower init paths (observed on Chromium builds where the
   * handshake settles well after READY) without turning into hammering.
   */
  const TWITCH_IFRAME_PLAY_RETRY_DELAYS = [150, 500, 1200, 2500, 5000, 8000, 12000, 16000, 25000, 40000];

  /**
   * Read-only per-cell diagnostics for a Twitch.Player iframe tile. Used by
   * window.twitchviewerIframeDiagnostics() — safe to run any time: calls only
   * documented getter APIs, guards every call, and mutates nothing. Missing
   * methods yield null rather than throwing.
   */
  function twitchIframeCellDiagnostics(cell) {
    const d = { channel: null, cellSize: null, iframe: null, player: null };
    if (!cell) return d;
    try {
      const key = (cell.dataset && cell.dataset.channelKey) || '';
      d.channel = key.replace(/^t:/, '') || null;
    } catch {
      /* ignore */
    }
    try {
      const r = cell.getBoundingClientRect();
      d.cellSize = { w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      /* ignore */
    }
    try {
      const iframe =
        typeof cell.querySelector === 'function'
          ? cell.querySelector('iframe[src*="player.twitch.tv"]')
          : null;
      if (iframe) {
        const ir = iframe.getBoundingClientRect();
        const allow = iframe.getAttribute('allow') || '';
        d.iframe = {
          w: Math.round(ir.width),
          h: Math.round(ir.height),
          allow,
          allowAutoplay: /\bautoplay\b/i.test(allow),
        };
      }
    } catch {
      /* ignore */
    }
    const p = cell._twitchPlayer;
    if (p) {
      const call = (fn) => {
        try {
          return typeof p[fn] === 'function' ? p[fn]() : null;
        } catch {
          return null;
        }
      };
      let qualities = null;
      try {
        const q = typeof p.getQualities === 'function' ? p.getQualities() : null;
        qualities = Array.isArray(q) ? q.length : null;
      } catch {
        /* ignore */
      }
      d.player = {
        exists: true,
        muted: call('getMuted'),
        paused: call('isPaused'),
        ended: call('getEnded'),
        qualities,
        readyAt: typeof cell._twitchReadyAt === 'number' ? cell._twitchReadyAt : null,
        onlineAt: typeof cell._twitchOnlineAt === 'number' ? cell._twitchOnlineAt : null,
        offlineAt: typeof cell._twitchOfflineAt === 'number' ? cell._twitchOfflineAt : null,
        playingConfirmed: cell._twitchPlaying === true,
        playingAt: typeof cell._twitchPlayingAt === 'number' ? cell._twitchPlayingAt : null,
        lastStateReason: cell._twitchPlayingReason || null,
        backgroundPaused: cell._twitchBgPaused === true,
        playbackBlockedCount: cell._twitchBlockedCount || 0,
        retryCount: cell._twitchRetries || 0,
        lastRetryAt: cell._twitchLastRetryAt || null,
        remounts: cell._twitchRemounts || 0,
      };
    }
    return d;
  }

  return {
    create,
    isUserGesture,
    twitchEmbedUserUnmuted,
    twitchCellIsPlaying,
    twitchIframeCellDiagnostics,
    TWITCH_IFRAME_PLAY_RETRY_DELAYS,
    PAUSE_USER,
    PAUSE_AUTO,
    PAUSE_RELOAD,
    PAUSE_ENDED,
    PAUSE_EXTERNAL,
    PLAY_AUTO,
    PLAY_USER,
    PLAY_EXTERNAL,
  };
});
