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
  /* Chromium's "Unmuting failed and the element was paused instead"
     intervention: on builds/configurations where the unmute does not itself
     satisfy autoplay policy, the browser pauses the element right after the
     user's unmute gesture. That pause is not an intent to pause — the user
     asked to keep watching, audibly — so it is classified separately and
     replayed rather than latching userPaused. */
  const PAUSE_UNMUTE = 'unmute';
  /* Chromium calls pause() synchronously inside the mute/volume setter, so the
     intervention 'pause' event is queued immediately after 'volumechange' —
     measured ~3.6ms in Chrome 150. The window is a main-thread-jank buffer
     (~80x headroom), not a semantic guess: even a heavily stalled event queue
     stays far below it, while a deliberate second user action (a real pause
     click) is slower than this. A rare false positive self-corrects — the
     user's next pause click simply latches again. */
  const UNMUTE_PAUSE_WINDOW_MS = 300;

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
    const now = (hooks && hooks.now) || (() => Date.now());

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
      /** Timestamp of the last user-gesture unmute/audible-volume change —
       *  lets classifyPause recognize Chromium's unmute-pause intervention. */
      lastUserUnmuteAt: -Infinity,
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
      if (gesture) {
        /* A pause landing right after the user's unmute gesture while the
           element is unmuted is Chromium's unmute-pause intervention — the
           browser blocked audible autoplay and paused instead. The user's
           intent was "keep watching, audible", so this is NOT a user pause. */
        if (!media.muted && now() - ctl.lastUserUnmuteAt < UNMUTE_PAUSE_WINDOW_MS)
          return PAUSE_UNMUTE;
        return PAUSE_USER;
      }
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
     *  state — this only records explicit user audio intent. The timestamp of
     *  a user unmute also arms the unmute-pause classifier (see classifyPause). */
    function onVolumeChange(gesture) {
      if (gesture) {
        ctl.userMuted = media.muted;
        if (!media.muted) ctl.lastUserUnmuteAt = now();
      }
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
   * Twitch embed autoplay compliance constants (dev.twitch.tv/docs/embed):
   * the interactive player must be at least 400x300 AND unobscured. In iframe
   * mode every TwitchViewer control (label, pin, chat toggle, drag grip) lives
   * in a dedicated header strip above the embed — never painted over the
   * iframe — so the embed keeps its full cell area minus the header.
   */
  const TWITCH_IFRAME_MIN_W = 400;
  const TWITCH_IFRAME_MIN_H = 300;
  const TWITCH_IFRAME_HEADER_H = 26;
  const TWITCH_IFRAME_MIN_CELL_W = TWITCH_IFRAME_MIN_W;
  const TWITCH_IFRAME_MIN_CELL_H = TWITCH_IFRAME_MIN_H + TWITCH_IFRAME_HEADER_H;

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

  /**
   * Read-only occlusion audit for a Twitch.Player iframe tile — approximates
   * what Twitch's in-iframe IntersectionObserver v2 "style visibility" check
   * sees. Samples document.elementsFromPoint at points covering the iframe
   * rect and reports which elements sit on top of the iframe at each point
   * (elements with pointer-events:none are skipped by elementsFromPoint —
   * that's noted, since IOv2 counts painted pixels regardless). Also reports
   * computed-style disqualifiers on the iframe and every ancestor that can
   * make IOv2 report isVisible=false (hidden/invisible/zero-opacity).
   * Never mutates anything; missing APIs yield null, not throws.
   */
  function twitchIframeVisibilityDiagnostics(cell, elementsFromPoint) {
    const d = {
      channel: null,
      iframe: null,
      ancestors: [],
      occlusion: null,
      overlayRects: {},
    };
    if (!cell || typeof cell.querySelector !== 'function') return d;
    try {
      const key = (cell.dataset && cell.dataset.channelKey) || '';
      d.channel = key.replace(/^t:/, '') || null;
    } catch {
      /* ignore */
    }
    const iframe = cell.querySelector('iframe[src*="player.twitch.tv"]');
    if (!iframe || typeof iframe.getBoundingClientRect !== 'function') return d;

    const rect = iframe.getBoundingClientRect();
    const vw =
      typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const vh =
      typeof window !== 'undefined' && window.innerHeight
        ? window.innerHeight
        : 0;
    const overlapW = Math.max(
      0,
      Math.min(rect.right, vw) - Math.max(rect.left, 0)
    );
    const overlapH = Math.max(
      0,
      Math.min(rect.bottom, vh) - Math.max(rect.top, 0)
    );

    const cs =
      typeof window !== 'undefined' && window.getComputedStyle
        ? (el) => {
            try {
              return window.getComputedStyle(el);
            } catch {
              return null;
            }
          }
        : () => null;
    const pick = (s) =>
      s
        ? {
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            position: s.position,
            zIndex: s.zIndex,
            transform: s.transform,
            filter: s.filter,
            contain: s.contain,
            contentVisibility: s.contentVisibility,
            overflow: s.overflow,
            pointerEvents: s.pointerEvents,
          }
        : null;

    d.iframe = {
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      viewport: { w: vw, h: vh },
      viewportOverlapW: Math.round(overlapW * 10) / 10,
      viewportOverlapH: Math.round(overlapH * 10) / 10,
      viewportRatio:
        rect.width > 0 && rect.height > 0
          ? Math.round(
              ((overlapW * overlapH) / (rect.width * rect.height)) * 1000
            ) / 1000
          : 0,
      fullyInViewport:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= vw &&
        rect.bottom <= vh,
      meetsMinSize: rect.width >= 400 && rect.height >= 300,
      style: pick(cs(iframe)),
    };

    /* Ancestor chain — a display:none / visibility:hidden / opacity:0 ancestor
       (or one still mid-layout) makes Twitch's in-iframe check fail even when
       the final layout looks fine. */
    try {
      let el = iframe.parentElement;
      while (el && el.nodeType === 1) {
        const cls = el.className && String(el.className).split(' ')[0];
        d.ancestors.push({
          tag: el.tagName ? el.tagName.toLowerCase() : '?',
          cls: cls || null,
          style: pick(cs(el)),
        });
        if (el === (cell.ownerDocument && cell.ownerDocument.body)) break;
        el = el.parentElement;
      }
    } catch {
      /* ignore */
    }

    /* Occlusion sampling: for each sample point over the iframe rect, list the
       top elements that are NOT the iframe (or inside it). These are what
       Twitch's IOv2 occlusion check can count as "obscured". */
    if (typeof elementsFromPoint === 'function') {
      const inset = 4;
      const pts = [
        ['center', rect.left + rect.width / 2, rect.top + rect.height / 2],
        ['topCenter', rect.left + rect.width / 2, rect.top + inset],
        [
          'bottomCenter',
          rect.left + rect.width / 2,
          rect.bottom - inset,
        ],
        ['leftCenter', rect.left + inset, rect.top + rect.height / 2],
        ['rightCenter', rect.right - inset, rect.top + rect.height / 2],
        ['topLeft', rect.left + inset, rect.top + inset],
        ['topRight', rect.right - inset, rect.top + inset],
        ['bottomLeft', rect.left + inset, rect.bottom - inset],
        ['bottomRight', rect.right - inset, rect.bottom - inset],
      ];
      const describe = (el) => {
        if (!el || !el.tagName) return String(el);
        const cls =
          el.className && typeof el.className === 'string'
            ? '.' + el.className.split(' ').join('.')
            : '';
        return `${el.tagName.toLowerCase()}${cls}`;
      };
      const out = {};
      for (const [name, x, y] of pts) {
        try {
          const stack = elementsFromPoint(x, y) || [];
          const above = [];
          let hitIframe = false;
          for (const el of stack) {
            if (el === iframe) {
              hitIframe = true;
              break;
            }
            if (typeof iframe.contains === 'function' && iframe.contains(el))
              continue;
            above.push(describe(el));
          }
          out[name] = { iframeHit: hitIframe, aboveIframe: above };
        } catch {
          out[name] = { iframeHit: null, aboveIframe: ['<error>'] };
        }
      }
      d.occlusion = out;
    }

    /* Known TwitchViewer overlay rectangles — for correlating the samples
       above with the controls we intentionally place on tiles. */
    try {
      for (const sel of [
        '.cell-label',
        '.cell-drag-handle',
        '.cell-focus-pin',
        '.cell-chat-toggle',
        '.cell-chat-wrap',
        '.cell-hls-error',
      ]) {
        const el = cell.querySelector(sel);
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const iw = Math.max(
          0,
          Math.min(r.right, rect.right) - Math.max(r.left, rect.left)
        );
        const ih = Math.max(
          0,
          Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top)
        );
        if (iw > 0 && ih > 0) {
          d.overlayRects[sel.slice(1)] = {
            overlapsIframe: true,
            w: Math.round(iw),
            h: Math.round(ih),
            pointerEvents: pick(cs(el))?.pointerEvents || null,
          };
        }
      }
    } catch {
      /* ignore */
    }

    return d;
  }

  /**
   * Sliding-window budget for recovery actions (source reloads, network
   * restarts). Every recovery path must pass through a limiter so that a
   * persistent failure condition (a playlist that keeps ending, a proxy that
   * keeps 503ing) degrades to "give up" instead of looping reloads forever.
   * The window self-heals: after `windowMs` of quiet, the full budget is
   * available again — transient storms are tolerated, infinite loops are not.
   *
   * @param {number} max — max allowed actions within the window
   * @param {number} windowMs — sliding window length
   * @param {() => number} [now] — clock (injectable for tests)
   * @returns {() => boolean} — call before each recovery action; true = allowed
   *   (and consumed), false = budget exhausted
   */
  function createRateLimiter(max, windowMs, now) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    const times = [];
    function tryAcquire() {
      const t = clock();
      while (times.length && t - times[0] >= windowMs) times.shift();
      if (times.length >= max) return false;
      times.push(t);
      return true;
    }
    /* Introspection for diagnostic snapshots — how much of the budget is
       currently consumed within the window. */
    tryAcquire.used = () => {
      const t = clock();
      while (times.length && t - times[0] >= windowMs) times.shift();
      return times.length;
    };
    return tryAcquire;
  }

  /**
   * Consecutive-failure budget: allowed while the failure streak is <= max;
   * reset() clears the streak (call it on any success — e.g. a playlist that
   * loaded). Unlike the sliding-window limiter this does not self-heal on
   * time alone: N failures in a row means the condition is persistent, not
   * transient, so we stop and surface an error instead of retrying forever.
   *
   * @param {number} max — max consecutive failures tolerated
   * @returns {{ tryAcquire(): boolean, reset(): void, count: number }}
   */
  function createConsecutiveLimiter(max) {
    let n = 0;
    return {
      tryAcquire() {
        n += 1;
        return n <= max;
      },
      reset() {
        n = 0;
      },
      get count() {
        return n;
      },
    };
  }

  return {
    create,
    createRateLimiter,
    createConsecutiveLimiter,
    isUserGesture,
    twitchEmbedUserUnmuted,
    twitchCellIsPlaying,
    twitchIframeCellDiagnostics,
    twitchIframeVisibilityDiagnostics,
    TWITCH_IFRAME_PLAY_RETRY_DELAYS,
    TWITCH_IFRAME_MIN_W,
    TWITCH_IFRAME_MIN_H,
    TWITCH_IFRAME_HEADER_H,
    TWITCH_IFRAME_MIN_CELL_W,
    TWITCH_IFRAME_MIN_CELL_H,
    PAUSE_USER,
    PAUSE_AUTO,
    PAUSE_RELOAD,
    PAUSE_ENDED,
    PAUSE_EXTERNAL,
    PAUSE_UNMUTE,
    PLAY_AUTO,
    PLAY_USER,
    PLAY_EXTERNAL,
  };
});
