/*
 * TwitchViewer playback diagnostic export — sanitisation + stable schema.
 *
 * Loadable both as a classic <script> (window.TwitchDiagnostics) and as a
 * Node module (tests). Pure functions only — app.js supplies all runtime
 * state, so this module can be unit-tested without a browser or Twitch.
 *
 * Export schema (diagnosticVersion: 1):
 *   {
 *     diagnosticVersion, capturedAt, markedProblem,
 *     application: { buildCommit, twitchPlayback, autoplay, hideOffline,
 *                    priorityTiles, sortByViews, tileCount },
 *     browser:     { userAgent, platform, language },
 *     server:      { twitchPlayback, pid, port, buildCommit, configured,
 *                    twitchHlsAvailable, twitchFilterAds },
 *     page:        { origin, path, visibilityState, viewport,
 *                    userActivation: { isActive, hasBeenActive } },
 *     tiles:       [ { channel, playerKind, generation, sourceId, state,
 *                      muted, volume, currentTime, paused, ended,
 *                      readyState, networkState, userPaused,
 *                      desiredPlaying, recovery: {ended, network, media} } ],
 *     history:     [ "HH:MM:SS.mmm channel message", ... ]
 *   }
 * Every string field passes through redactSensitive() — URLs keep
 * scheme://host/path but never query strings, tokens, or credentials.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TwitchDiagnostics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DIAGNOSTIC_VERSION = 1;

  /* Sensitive material must never leave the machine in a diagnostic file:
     query strings on URLs (sig/token params), bearer/basic auth material,
     and common credential-looking key=value pairs. */
  const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
  const SECRET_KV_RE =
    /((?:sig|token|oauth|auth|key|secret|password|passwd|credential|session|sid)[a-zA-Z0-9_-]*)(\s*[=:]\s*)(["']?)[^\s&"',\]}]+/gi;
  const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

  /**
   * Sanitise a single URL for diagnostics: keep scheme://host/path (host and
   * path are needed to distinguish e.g. playlist vs segment vs embed URLs);
   * drop query string, fragment, and userinfo entirely.
   */
  function sanitizeUrl(u) {
    if (u == null) return '';
    const s = String(u);
    const m = s.match(/^(https?):\/\/([^/?#]+)([^?#]*)/i);
    if (!m) {
      /* Not an http(s) URL — still scrub secret-looking kv pairs. */
      return s.replace(SECRET_KV_RE, '$1$2<redacted>').slice(0, 120);
    }
    const path = (m[3] || '/').replace(SECRET_KV_RE, '$1$2<redacted>');
    return `${m[1]}://${m[2]}${path.length > 80 ? path.slice(0, 80) + '…' : path}`;
  }

  /**
   * Scrub an arbitrary log/history line: every URL loses its query string;
   * bearer material and secret-looking key=value pairs are redacted.
   */
  function redactSensitive(text) {
    if (text == null) return '';
    let s = String(text);
    s = s.replace(URL_RE, (u) => sanitizeUrl(u));
    s = s.replace(BEARER_RE, '$1 <redacted>');
    s = s.replace(SECRET_KV_RE, '$1$2<redacted>');
    return s;
  }

  /**
   * Identity for a media source that is safe to share: scheme://host/path
   * (no query) plus a short tail so different sessions are distinguishable.
   */
  function sourceIdentity(currentSrc) {
    if (!currentSrc) return null;
    const clean = sanitizeUrl(currentSrc);
    const tail = clean.split('/').filter(Boolean).pop() || '';
    return { url: clean, tail: tail.slice(0, 32) };
  }

  function buildTileSnapshot(t) {
    if (!t || typeof t !== 'object') return null;
    return {
      channel: redactSensitive(t.channel || '?'),
      playerKind: t.playerKind || 'video',
      generation: t.generation ?? 0,
      source: sourceIdentity(t.currentSrc),
      state: t.state || null,
      muted: Boolean(t.muted),
      volume: typeof t.volume === 'number' ? +t.volume.toFixed(2) : null,
      currentTime: typeof t.currentTime === 'number' ? +t.currentTime.toFixed(1) : null,
      paused: Boolean(t.paused),
      ended: Boolean(t.ended),
      readyState: t.readyState ?? null,
      networkState: t.networkState ?? null,
      userPaused: t.userPaused ?? null,
      desiredPlaying: t.desiredPlaying ?? null,
      recovery: {
        ended: t.recovery?.ended ?? null,
        network: t.recovery?.network ?? null,
        media: t.recovery?.media ?? null,
      },
    };
  }

  /**
   * Assemble the stable diagnostic export. All inputs are plain data supplied
   * by the caller; every string passes through redactSensitive so secrets
   * cannot leak even if a caller hands us a raw URL or log line.
   *
   * @param {{
   *   application: object, browser: object, server: object, page: object,
   *   tiles: object[], history: string[], markedProblem?: object|null
   * }} input
   */
  function buildDiagnosticExport(input) {
    input = input || {};
    const pick = (obj, keys) => {
      const out = {};
      for (const k of keys) {
        const v = obj ? obj[k] : undefined;
        if (v !== undefined) out[k] = typeof v === 'string' ? redactSensitive(v) : v;
      }
      return out;
    };
    return {
      diagnosticVersion: DIAGNOSTIC_VERSION,
      capturedAt: new Date().toISOString(),
      markedProblem: input.markedProblem
        ? {
            at: input.markedProblem.at || null,
            note: redactSensitive(input.markedProblem.note || ''),
            snapshot: redactSensitive(input.markedProblem.snapshot || ''),
          }
        : null,
      application: pick(input.application, [
        'buildCommit', 'twitchPlayback', 'autoplay', 'hideOffline',
        'priorityTiles', 'sortByViews', 'tileCount', 'playbackDebugEnabled',
      ]),
      browser: pick(input.browser, ['userAgent', 'platform', 'language']),
      server: pick(input.server, [
        'twitchPlayback', 'pid', 'port', 'buildCommit', 'configured',
        'twitchHlsAvailable', 'twitchFilterAds',
      ]),
      page: {
        ...pick(input.page, ['origin', 'path', 'visibilityState', 'viewport']),
        userActivation: {
          isActive: Boolean(input.page?.userActivation?.isActive),
          hasBeenActive: Boolean(input.page?.userActivation?.hasBeenActive),
        },
      },
      tiles: (Array.isArray(input.tiles) ? input.tiles : [])
        .map(buildTileSnapshot)
        .filter(Boolean),
      history: (Array.isArray(input.history) ? input.history : [])
        .slice(-200)
        .map(redactSensitive),
    };
  }

  return {
    DIAGNOSTIC_VERSION,
    sanitizeUrl,
    redactSensitive,
    sourceIdentity,
    buildTileSnapshot,
    buildDiagnosticExport,
  };
});
