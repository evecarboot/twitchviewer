const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const selfsigned = require('selfsigned');
require('dotenv').config();

const app = express();
const root = __dirname;

/* Do not send a restrictive Permissions-Policy for autoplay: it can block cross-origin
   iframe playback (player.twitch.tv) even with muted + allow=autoplay. Sites like
   multitwitch.tv omit this; the iframe allow= attribute is enough. */

const SCOPES = 'user:read:email user:read:follows';

function getPort() {
  return Number(process.env.PORT) || 3000;
}

/**
 * Default: HTTPS (self-signed) so OAuth redirect URLs can use https:// (Twitch often
 * requires this for registered callbacks). Set USE_HTTP=true for plain HTTP only.
 */
function useHttpOnly() {
  return process.env.USE_HTTP === 'true';
}

/**
 * OAuth redirect_uri must match the Twitch console exactly.
 * localhost vs 127.0.0.1 are different to Twitch.
 * @param {import('express').Request} [req]
 */
function getRedirectUri(req) {
  if (process.env.TWITCH_REDIRECT_URI) {
    const u = process.env.TWITCH_REDIRECT_URI.trim();
    if (
      !useHttpOnly() &&
      u.startsWith('http://') &&
      /localhost|127\.0\.0\.1/.test(u)
    ) {
      console.warn(
        '[twitchviewer] TWITCH_REDIRECT_URI uses http:// but the server uses HTTPS. Use https:// in Twitch or set USE_HTTP=true in .env.'
      );
    }
    if (
      useHttpOnly() &&
      u.startsWith('https://') &&
      /localhost|127\.0\.0\.1/.test(u)
    ) {
      console.warn(
        '[twitchviewer] TWITCH_REDIRECT_URI uses https:// but the server uses HTTP (USE_HTTP=true). Use http:// in Twitch or remove USE_HTTP.'
      );
    }
    return u;
  }
  const proto = useHttpOnly() ? 'http' : 'https';
  if (req && typeof req.get === 'function' && req.get('host')) {
    return `${proto}://${req.get('host')}/auth/callback`;
  }
  return `${proto}://127.0.0.1:${getPort()}/auth/callback`;
}

let tokenCache = { token: null, expiresAt: 0 };

async function getAppToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return tokenCache.token;
}

/** Refresh a Twitch OAuth token. Works with any token object that has
 *  { accessToken, refreshToken, expiresAt } — used for req.session.twitch. */
async function refreshTokenObj(tokenObj) {
  if (!tokenObj?.refreshToken) return null;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokenObj.refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  tokenObj.accessToken = data.access_token;
  if (data.refresh_token) tokenObj.refreshToken = data.refresh_token;
  tokenObj.expiresAt = Date.now() + data.expires_in * 1000;
  return tokenObj.accessToken;
}

async function refreshUserSession(req) {
  const t = req.session.twitch;
  if (!t?.refreshToken) return null;
  return refreshTokenObj(t);
}

async function getUserAccessToken(req) {
  const t = req.session.twitch;
  if (!t?.accessToken) return null;
  if (t.expiresAt && Date.now() > t.expiresAt - 60_000) {
    const refreshed = await refreshUserSession(req);
    return refreshed;
  }
  return t.accessToken;
}

function helixHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Client-ID': process.env.TWITCH_CLIENT_ID,
  };
}

const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * SQLite session store (no temp+rename, avoids Windows EPERM from session-file-store + AV/sync).
 * Default on Windows → LOCALAPPDATA. Override directory with SESSION_FILE_PATH (file: sessions.sqlite inside it).
 */
function getSessionSqlitePath() {
  const envPath = process.env.SESSION_FILE_PATH?.trim();
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (/\.(sqlite|db)$/i.test(resolved)) {
      return resolved;
    }
    return path.join(resolved, 'sessions.sqlite');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || os.tmpdir();
    return path.join(base, 'twitchviewer', 'sessions.sqlite');
  }
  return path.join(__dirname, '.sessions.sqlite');
}

const sessionSqlitePath = getSessionSqlitePath();
const sessionSqliteDir = path.dirname(sessionSqlitePath);
const sessionDbName = path.basename(sessionSqlitePath);

try {
  fs.mkdirSync(sessionSqliteDir, { recursive: true });
} catch (e) {
  console.warn(
    '[twitchviewer] Could not create session directory:',
    sessionSqliteDir,
    e.message
  );
}

app.use(
  session({
    name: 'twitchviewer.sid',
    store: new SQLiteStore({
      db: sessionDbName,
      dir: sessionSqliteDir,
      table: 'sessions',
      concurrentDb: true,
      createDirIfNotExists: true,
    }),
    secret:
      process.env.SESSION_SECRET ||
      'change-me-in-production-use-long-random-string',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: !useHttpOnly(),
      maxAge: SESSION_MS,
      sameSite: 'lax',
    },
  })
);

app.use(express.json({ limit: '256kb' }));

/** Full path to streamlink.exe if not on PATH — see .env STREAMLINK_PATH */
function streamlinkExecutable() {
  const p = process.env.STREAMLINK_PATH?.trim();
  return p || 'streamlink';
}

/** Full path to ffmpeg.exe if not on PATH — see .env FFMPEG_PATH */
function ffmpegExecutable() {
  const p = process.env.FFMPEG_PATH?.trim();
  return p || 'ffmpeg';
}

function isStreamlinkAvailable() {
  const exe = streamlinkExecutable();
  try {
    const r = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** @type {boolean | null} */
let streamlinkCached = null;
function streamlinkWorks() {
  if (streamlinkCached === null) streamlinkCached = isStreamlinkAvailable();
  return streamlinkCached;
}

/** Current Twitch playback mode: 'proxy' (default, direct API or streamlink + pass-through,
 *  no ffmpeg), 'hls' (legacy streamlink + ffmpeg transcode), or 'iframe' (official embed).
 *  Proxy mode works without Streamlink installed — it uses Twitch's GQL + usher API directly. */
function currentTwitchPlayback() {
  const force = (process.env.TWITCH_PLAYBACK || '').trim().toLowerCase();
  if (force === 'iframe') return 'iframe';
  if (force === 'hls') return 'hls';
  return 'proxy';
}

app.get('/api/status', (req, res) => {
  const configured = Boolean(
    process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET
  );
  const sl = streamlinkWorks();
  res.json({
    configured,
    twitchPlayback: currentTwitchPlayback(),
    twitchHlsAvailable: sl,
  });
});

app.get('/api/me', async (req, res) => {
  const t = req.session.twitch;
  if (!t?.login) {
    return res.json({ authenticated: false });
  }
  await getUserAccessToken(req);
  res.json({
    authenticated: true,
    user: {
      login: t.login,
      displayName: t.displayName,
      profileImageUrl: t.profileImageUrl,
    },
  });
});

/* --- Channel points auth + status routes --- */

/** Check if the points subsystem is linked (has a valid web-session token). */
app.get('/api/points-auth/status', (_req, res) => {
  res.json({
    linked: Boolean(pointsToken?.accessToken),
    login: pointsToken?.login || null,
    deviceCodeInProgress: Boolean(deviceCodeState),
  });
});

/** Start the device code flow — returns the URL + code for the user to enter. */
app.post('/api/points-auth/device', async (_req, res) => {
  try {
    const result = await startPointsDeviceFlow();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** Poll for device code authorization completion. */
app.get('/api/points-auth/poll', async (_req, res) => {
  try {
    const result = await pollPointsDeviceFlow();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** Unlink the points token (clears the persisted token + stops watching). */
app.post('/api/points-auth/logout', (_req, res) => {
  pointsToken = null;
  pointsWatchLogins = new Set();
  pointsClaims = [];
  try { fs.unlinkSync(pointsTokenPath); } catch { /* ignore */ }
  res.json({ ok: true });
});

/** Set the list of Twitch logins to watch for bonus claims. */
app.post('/api/points/watch', (req, res) => {
  if (!pointsToken?.accessToken) {
    return res.status(401).json({ error: 'Not linked — use /api/points-auth/device first' });
  }
  const rawLogins = Array.isArray(req.body?.logins) ? req.body.logins : [];
  pointsWatchLogins = new Set(
    rawLogins
      .filter((l) => typeof l === 'string' && l.trim())
      .map((l) => l.trim().toLowerCase())
  );
  console.info(`[points] Watch list updated: ${pointsWatchLogins.size} channels (${[...pointsWatchLogins].slice(0, 5).join(', ')}${pointsWatchLogins.size > 5 ? '…' : ''})`);
  res.json({ watching: [...pointsWatchLogins] });
});

/** Client reports which streams are actively playing (have active video elements).
 *  Only these streams are reported to Twitch's Spade telemetry for points earning.
 *  This is distinct from the watch list (online channels) — playing means the
 *  user is actually consuming the stream in the viewer. */
app.post('/api/points/playing', (req, res) => {
  if (!pointsToken?.accessToken) {
    return res.status(401).json({ error: 'Not linked' });
  }
  const rawLogins = Array.isArray(req.body?.logins) ? req.body.logins : [];
  const newPlaying = new Set(
    rawLogins
      .filter((l) => typeof l === 'string' && l.trim())
      .map((l) => l.trim().toLowerCase())
  );
  /* Only log if the playing set changed (avoid noise). */
  if (newPlaying.size !== pointsPlayingLogins.size ||
      [...newPlaying].some((l) => !pointsPlayingLogins.has(l))) {
    console.info(`[points] Playing set updated: ${newPlaying.size} streams (${[...newPlaying].slice(0, 5).join(', ')}${newPlaying.size > 5 ? '…' : ''})`);
  }
  pointsPlayingLogins = newPlaying;
  res.json({ playing: [...pointsPlayingLogins] });
});

/** Manually prioritise channels for points-active slots. The user can pin
 *  specific channels to fill the 2 concurrent-stream slots first. Pass an
 *  empty array to clear manual priority (revert to automatic selection). */
app.post('/api/points/prioritize', (req, res) => {
  if (!pointsToken?.accessToken) {
    return res.status(401).json({ error: 'Not linked' });
  }
  const rawLogins = Array.isArray(req.body?.logins) ? req.body.logins : [];
  pointsPriorityLogins = rawLogins
    .filter((l) => typeof l === 'string' && l.trim())
    .map((l) => l.trim().toLowerCase())
    .slice(0, POINTS_MAX_CONCURRENT);
  console.info(`[points] Priority set: [${pointsPriorityLogins.join(', ') || 'none'}]`);
  /* Force immediate recompute. */
  recomputePointsActiveSlots();
  res.json({
    priority: [...pointsPriorityLogins],
    activeSlots: [...pointsActiveSlots],
  });
});

/** Get recent claims + current watch list + playing set + active slots. */
app.get('/api/points/status', (_req, res) => {
  res.json({
    linked: Boolean(pointsToken?.accessToken),
    login: pointsToken?.login || null,
    claims: pointsClaims.slice(0, 20),
    watching: [...pointsWatchLogins],
    playing: [...pointsPlayingLogins],
    activeSlots: [...pointsActiveSlots],
    bonusMonitored: getBonusMonitoredLogins(),
    priority: [...pointsPriorityLogins],
    balances: Object.fromEntries(pointsLastBalance),
    totalClaimed: pointsClaims.reduce((sum, c) => sum + (c.pointsEarned || 0), 0),
  });
});

app.get('/auth/twitch', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  if (!clientId) {
    return res
      .status(503)
      .type('html')
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login not configured</title></head><body style="font-family:sans-serif;max-width:36rem;margin:2rem;line-height:1.45">
<h1>Twitch login is not configured</h1>
<p>Copy <code>.env.example</code> to <code>.env</code> and set <strong>TWITCH_CLIENT_ID</strong> and <strong>TWITCH_CLIENT_SECRET</strong> from your <a href="https://dev.twitch.tv/console/apps">Twitch Developer Console</a> app, then restart the server.</p>
<p><a href="/">Back to viewer</a></p></body></html>`
      );
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: 'code',
    state,
  });
  const authorizeUrl = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  /** Persist oauth state before redirect so /auth/callback still sees it (file store is async). */
  req.session.save((err) => {
    if (err) {
      console.error('[twitchviewer] Session save failed before OAuth redirect:', err);
      return res
        .status(503)
        .type('html')
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login unavailable</title></head><body style="font-family:sans-serif;max-width:36rem;margin:2rem;line-height:1.45">
<h1>Could not start login</h1>
<p>The server could not save your session (needed for the Twitch redirect). Check that it can create/write the SQLite session file (see <code>SESSION_FILE_PATH</code> in <code>.env</code>; on Windows the default is under <code>%LOCALAPPDATA%\\twitchviewer\\sessions.sqlite</code>).</p>
<p><a href="/">Back to viewer</a></p></body></html>`
        );
    }
    res.redirect(authorizeUrl);
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    const msg = error_description || error || 'oauth_error';
    return res.redirect(`/?error=${encodeURIComponent(String(msg))}`);
  }
  if (
    !code ||
    !state ||
    typeof state !== 'string' ||
    state !== req.session.oauthState
  ) {
    console.warn(
      '[twitchviewer] OAuth callback rejected (missing code/state or state mismatch). Often: open the app with the same host you registered in Twitch (localhost vs 127.0.0.1), or set TWITCH_REDIRECT_URI to exactly that URL’s callback.'
    );
    return res.redirect('/?error=' + encodeURIComponent('Invalid login state'));
  }
  delete req.session.oauthState;

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const redirectUri = getRedirectUri(req);
  if (!clientId || !clientSecret) {
    return res.redirect('/?error=' + encodeURIComponent('Server missing Twitch credentials'));
  }

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.redirect(
        '/?error=' + encodeURIComponent(`Token exchange failed: ${text}`)
      );
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresAt = Date.now() + (tokenData.expires_in || 0) * 1000;

    const usersRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: helixHeaders(accessToken),
    });
    if (!usersRes.ok) {
      const text = await usersRes.text();
      return res.redirect(
        '/?error=' + encodeURIComponent(`Helix users failed: ${text}`)
      );
    }
    const usersBody = await usersRes.json();
    const user = (usersBody.data && usersBody.data[0]) || null;
    if (!user) {
      return res.redirect('/?error=' + encodeURIComponent('No Twitch user returned'));
    }

    req.session.twitch = {
      accessToken,
      refreshToken,
      expiresAt,
      userId: user.id,
      login: user.login,
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
    };

    res.redirect('/');
  } catch (e) {
    res.redirect(
      '/?error=' + encodeURIComponent(e.message || String(e))
    );
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/api/follows', async (req, res) => {
  const t = req.session.twitch;
  if (!t?.userId) {
    return res.status(401).json({ error: 'Not logged in', logins: [] });
  }
  const accessToken = await getUserAccessToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'Session expired', logins: [] });
  }

  const logins = [];
  let cursor = null;
  try {
    do {
      const params = new URLSearchParams({
        user_id: t.userId,
        first: '100',
      });
      if (cursor) params.set('after', cursor);

      const fr = await fetch(
        `https://api.twitch.tv/helix/channels/followed?${params.toString()}`,
        { headers: helixHeaders(accessToken) }
      );
      if (!fr.ok) {
        const text = await fr.text();
        return res.status(502).json({ error: text, logins: [] });
      }
      const body = await fr.json();
      for (const row of body.data || []) {
        const login = (row.broadcaster_login || '').toLowerCase();
        if (login) logins.push(login);
      }
      cursor = body.pagination?.cursor || null;
    } while (cursor);
    return res.json({ logins });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e), logins: [] });
  }
});

/** Twitch game IDs are effectively permanent — cache name → id lookups for a while. */
const gameIdCache = new Map();
const GAME_ID_CACHE_MS = 6 * 60 * 60 * 1000;

async function fetchGameByExactName(token, clientId, name) {
  const params = new URLSearchParams({ name });
  const r = await fetch(`https://api.twitch.tv/helix/games?${params.toString()}`, {
    headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const body = await r.json();
  return (body.data && body.data[0]) || null;
}

/** Fuzzy fallback for slugs (e.g. "eve-online") or partial/misspelled names. */
async function searchGameCategory(token, clientId, query) {
  const params = new URLSearchParams({ query, first: '10' });
  const r = await fetch(
    `https://api.twitch.tv/helix/search/categories?${params.toString()}`,
    { headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  const body = await r.json();
  const results = body.data || [];
  if (!results.length) return null;
  const norm = query.trim().toLowerCase();
  const exact = results.find((g) => (g.name || '').toLowerCase() === norm);
  return exact || results[0];
}

/**
 * Resolves a game/category by name. Tries an exact Helix match first (fast path for
 * names typed exactly as Twitch shows them), then de-hyphenates (users often paste the
 * directory URL slug, e.g. "eve-online"), then falls back to Twitch's fuzzy category
 * search so partial names/typos still work.
 */
async function resolveGameId(token, clientId, name) {
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  const cached = gameIdCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached;

  let game = await fetchGameByExactName(token, clientId, trimmed);
  if (!game && /-/.test(trimmed)) {
    game = await fetchGameByExactName(token, clientId, trimmed.replace(/-/g, ' '));
  }
  if (!game) {
    game = await searchGameCategory(token, clientId, trimmed.replace(/-/g, ' '));
  }
  if (!game) return null;

  const entry = {
    id: game.id,
    name: game.name,
    expiresAt: Date.now() + GAME_ID_CACHE_MS,
  };
  gameIdCache.set(key, entry);
  return entry;
}

/** Top live streams for a Twitch game/category — used by "Follow game" to auto-populate the grid. */
app.get('/api/category-streams', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Missing name', streams: [] });
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({
      error: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env',
      streams: [],
    });
  }
  const token = await getAppToken();
  if (!token) {
    return res
      .status(503)
      .json({ error: 'Could not obtain Twitch app token', streams: [] });
  }
  const wantAll = req.query.all === '1' || req.query.all === 'true';
  /** Hard safety cap so a huge category (e.g. "Just Chatting") can't flood the grid
   *  with hundreds of tiles when the user asks to follow every live stream. */
  const ALL_HARD_CAP = 200;
  const cap = wantAll
    ? ALL_HARD_CAP
    : Math.min(Math.max(parseInt(req.query.first, 10) || 6, 1), 100);
  try {
    const game = await resolveGameId(token, clientId, name);
    if (!game) {
      return res
        .status(404)
        .json({ error: `No Twitch category found for "${name}"`, streams: [] });
    }
    const streams = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({
        game_id: game.id,
        first: String(Math.min(100, cap - streams.length)),
      });
      if (cursor) params.set('after', cursor);
      const sr = await fetch(
        `https://api.twitch.tv/helix/streams?${params.toString()}`,
        { headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` } }
      );
      if (!sr.ok) {
        const text = await sr.text();
        return res
          .status(502)
          .json({ error: `Helix error ${sr.status}: ${text}`, streams: [] });
      }
      const body = await sr.json();
      for (const s of body.data || []) {
        streams.push({
          login: (s.user_login || '').toLowerCase(),
          displayName: s.user_name,
          title: s.title,
          viewerCount: s.viewer_count,
        });
      }
      cursor = body.pagination?.cursor || null;
    } while (wantAll && cursor && streams.length < cap);
    return res.json({
      gameId: game.id,
      gameName: game.name,
      streams,
      error: null,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e.message || String(e), streams: [] });
  }
});

app.get('/api/streams', async (req, res) => {
  const raw = req.query.login || '';
  const logins = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!logins.length) {
    return res.json({ online: [], viewers: {}, configured: false, error: null });
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({
      online: [],
      viewers: {},
      configured: false,
      error: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env',
    });
  }

  const token = await getAppToken();
  if (!token) {
    return res.status(503).json({
      online: [],
      viewers: {},
      configured: true,
      error: 'Could not obtain Twitch app token',
    });
  }

  const chunkSize = 100;
  const online = [];
  const viewers = {};
  try {
    for (let i = 0; i < logins.length; i += chunkSize) {
      const chunk = logins.slice(i, i + chunkSize);
      const params = new URLSearchParams();
      for (const login of chunk) params.append('user_login', login);

      const helix = await fetch(
        `https://api.twitch.tv/helix/streams?${params.toString()}`,
        {
          headers: {
            'Client-ID': clientId,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (!helix.ok) {
        const text = await helix.text();
        return res.status(502).json({
          online: [],
          viewers: {},
          configured: true,
          error: `Helix error ${helix.status}: ${text}`,
        });
      }
      const body = await helix.json();
      for (const s of body.data || []) {
        const login = s.user_login.toLowerCase();
        online.push(login);
        viewers[login] = s.viewer_count;
      }
    }
    return res.json({ online, viewers, configured: true, error: null });
  } catch (e) {
    return res.status(500).json({
      online: [],
      viewers: {},
      configured: true,
      error: e.message || String(e),
    });
  }
});

/** --- HLS transcoding (ffmpeg → H.264/AAC for browsers that can't play MPEG-2 TS) --- */

function isAllowedHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function transcodeHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

/** @type {Map<string, { url: string, dir: string, proc: import('child_process').ChildProcess | null, error?: string }>} */
const transcodeState = new Map();

function killAllTranscoders() {
  for (const [, v] of transcodeState) {
    if (v.proc && !v.proc.killed) {
      try {
        v.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  transcodeState.clear();
}

process.on('exit', killAllTranscoders);
process.on('SIGINT', killAllTranscoders);
process.on('SIGTERM', killAllTranscoders);

/**
 * @param {string} hash
 * @param {string} url
 * @param {{ twitch?: boolean }} [options] — twitch: lighter defaults (multi-stream CPU load)
 */
function startFfmpegIfNeeded(hash, url, options) {
  const twitchMode = Boolean(options && options.twitch);
  const existing = transcodeState.get(hash);
  if (existing && existing.proc && !existing.error) return;
  if (existing && existing.error) transcodeState.delete(hash);
  const dir = path.join(root, '.hls-transcode', hash);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, 'playlist.m3u8');
  const segPattern = path.join(dir, 'seg_%03d.ts').replace(/\\/g, '/');
  const playlistArg = playlist.replace(/\\/g, '/');

  const preset = twitchMode
    ? (process.env.TWITCH_FFMPEG_PRESET || 'ultrafast').trim() || 'ultrafast'
    : (process.env.FFMPEG_PRESET || 'veryfast').trim() || 'veryfast';

  const vfArgs = [];
  if (twitchMode) {
    const noScale =
      process.env.TWITCH_FFMPEG_NO_SCALE === '1' ||
      process.env.TWITCH_FFMPEG_NO_SCALE === 'true';
    if (!noScale) {
      const mh = process.env.TWITCH_FFMPEG_MAX_HEIGHT?.trim();
      if (mh === '0') {
        /* no scale */
      } else if (mh && /^\d+$/.test(mh)) {
        vfArgs.push('-vf', `scale=-2:${mh}`);
      } else {
        vfArgs.push('-vf', 'scale=-2:720');
      }
    }
  } else {
    const maxH = process.env.FFMPEG_MAX_HEIGHT;
    if (maxH && /^\d+$/.test(String(maxH).trim())) {
      vfArgs.push('-vf', `scale=-2:${String(maxH).trim()}`);
    }
  }

  const hlsTime = twitchMode
    ? Math.min(10, Math.max(2, parseInt(process.env.TWITCH_HLS_TIME || '4', 10) || 4))
    : 2;
  const hlsListSize = twitchMode ? 12 : 8;

  /** Pace network input so ffmpeg doesn’t decode faster than realtime (helps many streams). */
  const beforeInput = twitchMode
    ? ['-fflags', '+genpts', '-re']
    : ['-fflags', '+genpts'];

  const proc = spawn(
    ffmpegExecutable(),
    [
      '-y',
      '-loglevel',
      'warning',
      ...beforeInput,
      '-i',
      url,
      ...vfArgs,
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-tune',
      'zerolatency',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      twitchMode ? '96k' : '128k',
      '-ar',
      '48000',
      '-f',
      'hls',
      '-hls_time',
      String(hlsTime),
      '-hls_list_size',
      String(hlsListSize),
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      segPattern,
      playlistArg,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );

  const entry = { url, dir, proc };
  transcodeState.set(hash, entry);

  proc.stderr.on('data', (buf) => {
    if (process.env.DEBUG_FFMPEG) {
      process.stderr.write(buf);
    }
  });
  proc.on('error', (err) => {
    console.error(
      '[transcode] ffmpeg not found or failed to start. Install ffmpeg, add it to PATH, or set FFMPEG_PATH in .env.',
      err.message
    );
    entry.error = err.message;
    entry.proc = null;
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(
        `[transcode] ffmpeg exited with code ${code} for ${hash.slice(0, 8)}…`
      );
    }
    transcodeState.delete(hash);
  });
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      const st = await fs.promises.stat(filePath);
      if (st.size > 0) return true;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

app.get('/api/transcode/hash', (req, res) => {
  const url = req.query.url;
  if (!url || !isAllowedHttpUrl(String(url))) {
    return res.status(400).json({ error: 'Invalid or missing url' });
  }
  res.json({ hash: transcodeHash(String(url)) });
});

app.get('/api/transcode/status', (_req, res) => {
  const p = spawn(ffmpegExecutable(), ['-version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    res.json({ ffmpeg: ok });
  };
  p.on('error', () => finish(false));
  p.on('exit', (code) => finish(code === 0));
});

app.get('/api/transcode/:hash/playlist.m3u8', async (req, res) => {
  const hash = req.params.hash;
  const source = req.query.source ? String(req.query.source) : '';
  if (source) {
    if (!isAllowedHttpUrl(source)) {
      return res.status(400).send('Invalid source URL');
    }
    if (transcodeHash(source) !== hash) {
      return res.status(400).send('Hash does not match source URL');
    }
    startFfmpegIfNeeded(hash, source);
  } else if (!transcodeState.has(hash)) {
    return res
      .status(400)
      .send(
        'Missing ?source= URL query (required the first time after server start).'
      );
  }

  const entry = transcodeState.get(hash);
  if (entry && entry.error) {
    return res.status(503).type('text').send(`ffmpeg: ${entry.error}`);
  }
  if (!entry) {
    return res.status(503).type('text').send('Transcoder not running.');
  }

  const playlistPath = path.join(entry.dir, 'playlist.m3u8');
  const ok = await waitForFile(playlistPath, 30000);
  if (!ok) {
    return res
      .status(503)
      .type('text')
      .send(
        'Playlist not ready. Is ffmpeg installed? Check the server console for ffmpeg errors.'
      );
  }
  res.sendFile(playlistPath);
});

app.get('/api/transcode/:hash/:segment', (req, res) => {
  const { hash, segment } = req.params;
  if (!/^seg_\d+\.ts$/i.test(segment)) {
    return res.status(404).end();
  }
  const entry = transcodeState.get(hash);
  if (!entry || entry.error) {
    return res.status(404).end();
  }
  const filePath = path.join(entry.dir, segment);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).end();
  });
});

function normalizeTwitchLoginParam(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(t)) return null;
  return t;
}

function twitchLiveSourceKey(login) {
  return `twitch://live/${login}`;
}

function streamlinkQualityArg() {
  const raw = (process.env.TWITCH_STREAMLINK_QUALITY || '720p60').trim() || '720p60';
  return /^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(raw) ? raw : '720p60';
}

/** Twitch often exposes 720p60 / 480p30, not a bare "720p" — try fallbacks if the preferred name fails.
 *  @param {string} [preferred] — quality requested by the client (e.g. '360p30'); falls back upward if unavailable. */
function streamlinkQualityCandidates(preferred) {
  const primary = (preferred && String(preferred).trim()) || streamlinkQualityArg();
  const fallbacks = [
    '720p60',
    '720p30',
    '720p',
    '480p30',
    '480p',
    '360p30',
    '360p',
    '160p',
    'best',
  ];
  const seen = new Set();
  const list = [];
  for (const q of [primary, ...fallbacks]) {
    if (q && !seen.has(q)) {
      seen.add(q);
      list.push(q);
    }
  }
  return list;
}

function resolveStreamlinkStreamUrlOnce(login, quality) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      streamlinkExecutable(),
      ['--stream-url', `https://www.twitch.tv/${login}`, quality],
      { windowsHide: true }
    );
    let out = '';
    let errBuf = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.stderr.on('data', (d) => {
      errBuf += d.toString();
    });
    proc.on('error', (e) => {
      reject(
        new Error(
          `streamlink: ${e.message}. Install from https://streamlink.github.io/ and ensure it is on PATH.`
        )
      );
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        const msg = (errBuf || out || '').trim() || `exit ${code}`;
        reject(
          new Error(
            `streamlink [${quality}] (stream offline, unknown quality name, or error): ${msg.slice(0, 500)}`
          )
        );
        return;
      }
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const url = lines[lines.length - 1];
      if (!url || !/^https?:\/\//i.test(url)) {
        reject(new Error('streamlink did not return a stream URL'));
        return;
      }
      resolve(url);
    });
  });
}

async function resolveStreamlinkStreamUrl(login, preferred) {
  const candidates = streamlinkQualityCandidates(preferred);
  let lastErr = '';
  for (const quality of candidates) {
    try {
      return await resolveStreamlinkStreamUrlOnce(login, quality);
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
  }
  throw new Error(lastErr || 'streamlink failed for all quality fallbacks');
}

/**
 * --- Twitch pass-through proxy (proxy mode) ---
 * The server resolves a CDN media-playlist URL per (login, quality), fetches it, rewrites
 * segment URIs to point back through /api/twitch-live, and pipes .ts bytes through unchanged.
 * No ffmpeg, no transcode — just HTTP proxying. The client picks the quality per tile pixel
 * size so small tiles only decode 360p/480p, big tiles get 720p60.
 *
 * URL resolution has two strategies, tried in order:
 *  1. Direct API (no install needed): Twitch GQL → playback token → usher master playlist →
 *     pick the variant matching the requested quality. Uses the well-known web client_id.
 *  2. Streamlink fallback: `streamlink --stream-url <quality>` — requires Streamlink installed.
 *     Catches cases where the direct API breaks (Twitch schema changes, etc.).
 */

/** Well-known Twitch web client_id used by youtube-dl/streamlink for GQL queries. */
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

/** @type {Map<string, {url: string, promise: Promise<string>|null, ts: number}>} key = `${login}|${quality}` */
const twitchProxyCache = new Map();
/** Re-resolve frequently so segment URLs embedded in the playlist don't expire before the
 *  cache does. Twitch CDN segment URLs are short-lived (~1-2 min); caching the CDN URL for
 *  30s means hls.js gets fresh segment URLs on every other playlist poll. */
const TWITCH_PROXY_TTL_MS = 30 * 1000;
/** Whitelist of quality names the client is allowed to request via ?q=. */
const TWITCH_PROXY_QUALITIES = new Set([
  '160p', '360p30', '360p', '480p30', '480p', '720p60', '720p30', '720p', 'best',
]);

function sanitizeProxyQuality(q) {
  const s = String(q || '').trim().toLowerCase();
  return TWITCH_PROXY_QUALITIES.has(s) ? s : streamlinkQualityArg();
}

/* --- Direct API: GQL playback token (cached per login+playerType) --- */
/** @type {Map<string, {token: {value: string, signature: string}, ts: number}>} key = `${login}|${playerType}` */
const twitchTokenCache = new Map();
/** Tokens are cheap to fetch (one GQL POST); cache briefly to avoid rate limits. */
const TWITCH_TOKEN_TTL_MS = 2 * 60 * 1000;

/** Fetch a Twitch playback token via GQL. playerType controls which "player" Twitch thinks
 *  is requesting the stream — different types get different ad insertion policies.
 *  'embed' = source quality (may have ads), 'autoplay' = 360p only (usually ad-free),
 *  'popout' = source quality (sometimes ad-free). Used by the ad-blocking fallback. */
async function fetchTwitchPlaybackToken(login, playerType = 'embed') {
  const cacheKey = `${login}|${playerType}`;
  const now = Date.now();
  const cached = twitchTokenCache.get(cacheKey);
  if (cached && now - cached.ts < TWITCH_TOKEN_TTL_MS) return cached.token;

  // 'autoplay' uses platform 'android' (matches what vaft/TwitchAdSolutions does —
  // the android player type reliably gets ad-free 360p streams).
  const platform = playerType === 'autoplay' ? 'android' : 'web';
  const query = {
    operationName: 'PlaybackAccessToken',
    query:
      `query PlaybackAccessToken($login: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "${platform}", playerBackend: "mediaplayer", playerType: "${playerType}"}) { value signature } }`,
    variables: { login },
  };
  const postRes = await new Promise((resolve, reject) => {
    const body = JSON.stringify(query);
    const req = https.request(
      'https://gql.twitch.tv/gql',
      {
        method: 'POST',
        headers: {
          'Client-ID': TWITCH_WEB_CLIENT_ID,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('GQL timeout')));
    req.write(body);
    req.end();
  });

  if (postRes.status !== 200) {
    throw new Error(`Twitch GQL returned ${postRes.status}: ${postRes.body.slice(0, 200)}`);
  }
  const j = JSON.parse(postRes.body);
  const spat = j.data && j.data.streamPlaybackAccessToken;
  if (!spat || !spat.value || !spat.signature) {
    const errs = j.errors ? j.errors.map((e) => e.message).join('; ') : 'unknown';
    throw new Error(`Twitch GQL: no playback token (${errs})`);
  }
  const token = { value: spat.value, signature: spat.signature };
  twitchTokenCache.set(cacheKey, { token, ts: now });
  return token;
}

/* --- Channel points auto-claim (Twitch web-session subsystem) ---
 *
 * Twitch's GQL endpoint (gql.twitch.tv) is an internal API that rejects tokens
 * issued to custom developer applications. To auto-claim channel-points bonuses
 * (the "+50" that appears periodically), we need a token issued by Twitch's own
 * client — not our developer app's client.
 *
 * This subsystem is architecturally separate from the existing developer OAuth
 * (which handles follows/profile via Helix). It uses Twitch's device code flow
 * with the TV client_id (ue6666qo983tsx6so1t0vnawi233wa), which is the same
 * approach used by rdavydov's Twitch-Channel-Points-Miner-v2. The user
 * links their Twitch account once via a device code (like Netflix/YouTube on a
 * TV), and the resulting token is persisted to disk and used for GQL channel-
 * points operations.
 *
 * Flow:
 *  1. User clicks "Link for points" → server starts device code flow
 *  2. User visits twitch.tv/activate, enters the code
 *  3. Server polls Twitch until authorized, persists the token
 *  4. Background poller checks each watched channel for available bonus claims
 *     every 60s and auto-claims them via the ClaimCommunityPoints GQL mutation
 *  5. Client polls /api/points/status for the running total
 *
 * Only bonus points (free claims) are auto-collected. We do NOT auto-redeem
 * rewards (spending points on channel-specific rewards) — that would be
 * destructive and channel-specific.
 *
 * GQL operations use Twitch's persisted-query system (sha256Hash) rather than
 * raw query strings — this is what Twitch's own clients send, and it's more
 * stable. The hashes are defined as constants below so they can be updated
 * easily when Twitch changes them. */

/** Twitch TV client_id — used for the device code flow and all GQL calls in
 *  the points subsystem. This is the same client_id used by rdavydov's
 *  Twitch-Channel-Points-Miner-v2. The token and client ID must remain paired:
 *  a token obtained with this client_id must only be used with this client_id. */
const TWITCH_POINTS_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

/** Client-Version header value — matches rdavydov's browser client version. */
const TWITCH_POINTS_CLIENT_VERSION = 'ef928475-9403-42f2-8a34-55784bd08e16';

/** User-Agent header value — matches rdavydov's Windows Chrome user agent. */
const TWITCH_POINTS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

/* --- Persisted GQL operation hashes ---
 * These are Twitch's internal persisted-query hashes from rdavydov's
 * Twitch-Channel-Points-Miner-v2 (master branch). If Twitch changes their GQL
 * schema, these hashes may need updating.
 *
 * We send ONLY the persisted operation (operationName + variables + extensions.
 * persistedQuery). No raw query text is sent alongside the hash — a persisted
 * hash describes an exact GraphQL document and sending arbitrary query text
 * with an unrelated hash produces "persistedQuery sha256 hash does not match
 * query body". */
const GQL_HASH_CHANNEL_POINTS_CONTEXT = '7fe050e3761eb2cf258d70ee1a21cbd76fa8cf3d7e7b12fc437e7029d446b5e3';
const GQL_HASH_CLAIM_COMMUNITY_POINTS = '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0';
/* VideoPlayerStreamInfoOverlayChannel — returns stream broadcast_id, game info.
 * Used for spade minute-watched payload (broadcast_id is required). */
const GQL_HASH_STREAM_INFO = '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d';
/* PlaybackAccessToken — authenticated playback token. The token value embeds
 * user_id, channel_id, player_type, user_ip. Used to establish an authenticated
 * watch session. */
const GQL_HASH_PLAYBACK_ACCESS_TOKEN = '3093517e37e4f4cb48906155bcd894150aef92617939236d2508f3375ab732ce';

/** Build a persisted-query GQL operation object (hash only, no query text). */
function gqlPersistedOp(operationName, sha256Hash, variables) {
  return {
    operationName,
    variables,
    extensions: {
      persistedQuery: { version: 1, sha256Hash },
    },
  };
}

/** Generate a random alphanumeric string of the given length (for X-Device-Id).
 *  rdavydov uses `choice(string.ascii_letters + string.digits)` for 32 chars. */
function randomAlnumId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/** Generate a random hex string of the given length (for Client-Session-Id). */
function randomHexId(length) {
  const bytes = crypto.randomBytes(Math.ceil(length / 2));
  return bytes.toString('hex').slice(0, length);
}

/* --- First-party device identifiers ---
 * Twitch's web/TV clients send persistent device + session IDs with GQL calls.
 * We generate and persist these to mimic a real first-party client:
 *  - X-Device-Id: 32 alphanumeric chars, generated ONCE per persisted points
 *    installation (survives server restarts)
 *  - Client-Session-Id: 32 hex chars, generated ONCE per application session
 *    (regenerated on server restart, not per channel/request) */
const pointsDeviceIdPath = path.join(sessionSqliteDir, 'points-device-id.txt');
let pointsDeviceId = (() => {
  try { return fs.readFileSync(pointsDeviceIdPath, 'utf8').trim(); } catch { return null; }
})();
if (!pointsDeviceId || pointsDeviceId.length !== 32) {
  pointsDeviceId = randomAlnumId(32);
  try { fs.writeFileSync(pointsDeviceIdPath, pointsDeviceId); } catch { /* ignore */ }
}
/** Per-application-session session ID (generated once on server start, not
 *  regenerated per poll cycle or per channel). */
const pointsClientSessionId = randomHexId(32);

/** Path to the persisted points token (JSON file in the app data directory). */
const pointsTokenPath = path.join(sessionSqliteDir, 'points-token.json');

/** Load the persisted points token from disk. Returns null if not linked. */
function loadPointsToken() {
  try {
    const raw = fs.readFileSync(pointsTokenPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.accessToken && parsed.refreshToken) return parsed;
    return null;
  } catch (e) {
    console.warn(`[points] Could not load token from disk: ${e.message}`);
    return null;
  }
}

/** Save the points token to disk so it survives server restarts. */
function savePointsToken(token) {
  try {
    fs.writeFileSync(pointsTokenPath, JSON.stringify(token, null, 2));
  } catch (e) {
    console.warn(`[points] Could not save token: ${e.message}`);
  }
}

/** @type {{accessToken: string, refreshToken: string, expiresAt: number, login: string, userId: string|null, clientId: string} | null} */
let pointsToken = loadPointsToken();

/* If the persisted token was obtained with a different client_id (e.g. the old
   Android TV client), it's invalid for the current client — delete it so the
   user re-links with the correct client. The token and client ID must be paired. */
if (pointsToken && pointsToken.clientId && pointsToken.clientId !== TWITCH_POINTS_CLIENT_ID) {
  console.info(`[points] Persisted token was for client ${pointsToken.clientId.slice(0, 8)}… — clearing (now using ${TWITCH_POINTS_CLIENT_ID.slice(0, 8)}…)`);
  pointsToken = null;
  try { fs.unlinkSync(pointsTokenPath); } catch { /* ignore */ }
}

/* Backfill userId if the persisted token predates the userId field (don't
   force a re-link just because userId wasn't stored yet). The token itself
   is still valid — we just need the numeric user ID for Spade telemetry. */
if (pointsToken && pointsToken.accessToken && !pointsToken.userId) {
  (async () => {
    try {
      const userRes = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          Authorization: `Bearer ${pointsToken.accessToken}`,
          'Client-ID': TWITCH_POINTS_CLIENT_ID,
        },
      });
      if (userRes.ok) {
        const userBody = await userRes.json();
        const userId = userBody.data?.[0]?.id || null;
        if (userId) {
          pointsToken.userId = userId;
          savePointsToken(pointsToken);
          console.info(`[points] Backfilled userId for ${pointsToken.login}: ${userId}`);
        }
      } else if (userRes.status === 401 || userRes.status === 403) {
        console.warn(`[points] Token invalid during userId backfill (${userRes.status}) — will refresh on next GQL call`);
      } else {
        console.warn(`[points] Helix user lookup failed during backfill (${userRes.status})`);
      }
    } catch (e) {
      console.warn(`[points] userId backfill error: ${e.message}`);
    }
  })();
}

/** In-memory state for the device code flow (short-lived, expires in ~5 min). */
let deviceCodeState = null;

/** Recent claims (newest first, capped at 50). */
let pointsClaims = [];
/** Set of Twitch logins currently being watched for bonus claims. */
let pointsWatchLogins = new Set();
let pointsLastPoll = 0;

/** Start the Twitch device code flow. Returns the verification URL + user code
 *  for the user to enter at twitch.tv/activate.
 *
 *  NOTE: Twitch's DCF is non-standard — it uses `scopes` (plural) instead of
 *  the RFC 8628 `scope` parameter. Using `scope` silently results in a token
 *  with no scopes. */
async function startPointsDeviceFlow() {
  const res = await fetch('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_POINTS_CLIENT_ID,
      scopes: 'user:read:email',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code flow failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.device_code || !data.user_code) {
    throw new Error(`Device code flow returned unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  deviceCodeState = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://www.twitch.tv/activate',
    expiresAt: Date.now() + (data.expires_in || 600) * 1000,
    interval: (data.interval || 5) * 1000,
    lastPoll: 0,
  };
  return {
    userCode: data.user_code,
    verificationUri: deviceCodeState.verificationUri,
    expiresIn: data.expires_in || 600,
  };
}

/** Poll Twitch for the device code authorization. Returns:
 *  - { status: 'pending' } if the user hasn't authorized yet
 *  - { status: 'linked', login } on success
 *  - { status: 'expired' } if the device code expired
 *  - { status: 'error', error } on other errors */
async function pollPointsDeviceFlow() {
  if (!deviceCodeState) return { status: 'error', error: 'No device code flow in progress' };
  if (Date.now() > deviceCodeState.expiresAt) {
    deviceCodeState = null;
    return { status: 'expired' };
  }
  /* Throttle polling to Twitch's requested interval. */
  if (Date.now() - deviceCodeState.lastPoll < deviceCodeState.interval) {
    return { status: 'pending' };
  }
  deviceCodeState.lastPoll = Date.now();

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_POINTS_CLIENT_ID,
      device_code: deviceCodeState.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const rawBody = await res.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    console.warn(`[points] Token endpoint returned non-JSON (${res.status}): ${rawBody.slice(0, 500)}`);
    deviceCodeState = null;
    return { status: 'error', error: 'Twitch returned invalid response' };
  }

  /* Twitch's device code flow uses {status, message} instead of the standard
     OAuth {error, error_description} format. Handle both for safety. */
  const msg = data.message || data.error || '';

  if (msg === 'authorization_pending') return { status: 'pending' };
  if (msg === 'slow_down') {
    deviceCodeState.interval += 5000;
    return { status: 'pending' };
  }
  if (msg === 'expired_token' || msg === 'Token expired') {
    deviceCodeState = null;
    return { status: 'expired' };
  }
  if (data.error || (data.status && data.status >= 400 && !data.access_token)) {
    console.warn(`[points] Device auth error (${res.status}): ${rawBody.slice(0, 500)}`);
    deviceCodeState = null;
    return { status: 'error', error: data.error_description || data.message || data.error || 'Unknown error' };
  }
  if (!data.access_token) {
    console.warn(`[points] Token endpoint returned no access_token (${res.status}): ${rawBody.slice(0, 500)}`);
    deviceCodeState = null;
    return { status: 'error', error: `No access token in response` };
  }

  /* Clear device code state immediately so concurrent polls don't double-link. */
  deviceCodeState = null;

  /* Success — resolve the user's login via Helix (using the same token/client). */
  let login = 'unknown';
  let userId = null;
  try {
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        'Client-ID': TWITCH_POINTS_CLIENT_ID,
      },
    });
    if (userRes.ok) {
      const userBody = await userRes.json();
      login = userBody.data?.[0]?.login || 'unknown';
      userId = userBody.data?.[0]?.id || null;
    } else {
      console.warn(`[points] Helix user lookup failed (${userRes.status}) — token is valid but login unknown`);
    }
  } catch (e) {
    console.warn(`[points] Helix user lookup error: ${e.message} — token is valid but login unknown`);
  }

  pointsToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    /* Twitch's TV client doesn't return expires_in — assume a long-lived
       token (~60 days). We'll refresh on 401 instead of proactively. */
    expiresAt: Date.now() + ((data.expires_in || 5184000) * 1000),
    login,
    userId,
    clientId: TWITCH_POINTS_CLIENT_ID,
  };
  savePointsToken(pointsToken);
  console.info(`[points] linked as ${login}`);
  return { status: 'linked', login };
}

/** Refresh the points token using the refresh token. Returns the new access
 *  token string, or null if refresh failed (token cleared, re-link needed). */
async function refreshPointsToken() {
  if (!pointsToken?.refreshToken) return null;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_POINTS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: pointsToken.refreshToken,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[points] Token refresh failed (${res.status}): ${text.slice(0, 500)} — re-link needed`);
      pointsToken = null;
      try { fs.unlinkSync(pointsTokenPath); } catch { /* ignore */ }
      return null;
    }
    const data = await res.json();
    if (!data.access_token) {
      console.warn(`[points] Token refresh returned no access_token: ${JSON.stringify(data).slice(0, 500)} — re-link needed`);
      pointsToken = null;
      try { fs.unlinkSync(pointsTokenPath); } catch { /* ignore */ }
      return null;
    }
    pointsToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || pointsToken.refreshToken,
      /* Twitch's TV client doesn't return expires_in — assume long-lived. */
      expiresAt: Date.now() + ((data.expires_in || 5184000) * 1000),
      login: pointsToken.login,
      userId: pointsToken.userId,
      clientId: TWITCH_POINTS_CLIENT_ID,
    };
    savePointsToken(pointsToken);
    console.info(`[points] Token refreshed for ${pointsToken.login}`);
    return pointsToken.accessToken;
  } catch (e) {
    console.warn(`[points] Token refresh error: ${e.message} — re-link needed`);
    pointsToken = null;
    try { fs.unlinkSync(pointsTokenPath); } catch { /* ignore */ }
    return null;
  }
}

/** Return a valid (non-expired) points access token, refreshing if needed. */
async function getValidPointsToken() {
  if (!pointsToken?.accessToken) return null;
  if (pointsToken.expiresAt && Date.now() > pointsToken.expiresAt - 60_000) {
    return refreshPointsToken();
  }
  return pointsToken.accessToken;
}

/** POST a GQL operation using the points token + Android client_id, including
 *  first-party headers (X-Device-Id, Client-Session-Id) that Twitch's own
 *  clients send. Returns { status, body } or throws on network error. */
async function gqlWithPointsToken(queryObj) {
  const token = await getValidPointsToken();
  if (!token) throw new Error('No points token — re-link needed');
  const body = JSON.stringify(queryObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://gql.twitch.tv/gql',
      {
        method: 'POST',
        headers: {
          'Client-ID': TWITCH_POINTS_CLIENT_ID,
          Authorization: `OAuth ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          /* First-party headers matching rdavydov's Twitch-Channel-Points-Miner-v2.
             These identify the client as a real Twitch TV/web session. */
          'Client-Session-Id': pointsClientSessionId,
          'Client-Version': TWITCH_POINTS_CLIENT_VERSION,
          'User-Agent': TWITCH_POINTS_USER_AGENT,
          'X-Device-Id': pointsDeviceId,
        },
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          resolve({
            status: resp.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('GQL timeout')));
    req.write(body);
    req.end();
  });
}

/** Check all watched channels for available bonus claims and auto-claim them.
 *  Uses Twitch's persisted GQL operations (ChannelPointsContext + ClaimCommunityPoints)
 *  with proper operationName, variables, and extensions.persistedQuery. */
/** Track whether we've logged the first successful ChannelPointsContext
 *  response structure (for debugging the data path). Reset on server start. */
let pointsLoggedFirstResponse = false;
/** Track whether we've logged the first successful ClaimCommunityPoints
 *  response (full JSON) for debugging. Reset on server start. */
let pointsLoggedFirstClaim = false;
/** Per-channel balance snapshot taken before a claim, so we can compute the
 *  earned amount via balance delta on the next ChannelPointsContext poll.
 *  Map<login, { balanceBefore: number, claimId: string, claimTs: number }>. */
const pointsPendingBalanceCheck = new Map();
/** Per-channel last known balance (for delta comparison). Map<login, number>. */
const pointsLastBalance = new Map();

/** Guard to prevent overlapping poll cycles. If a poll takes longer than the
 *  15s interval, subsequent ticks will skip until the in-flight poll finishes. */
let pointsPollInProgress = false;

/** Set of claim IDs currently being claimed (in-flight). Prevents the same
 *  availableClaim.id from being queued twice if two poll cycles overlap or
 *  if a claim is still processing when the next poll finds it again. */
const inFlightClaimIds = new Set();

/** Compute the bonus-monitored set: Playing ∩ Live.
 *  This is the set of channels that are both actively playing in the viewer
 *  AND currently live on Twitch. All of these get ChannelPointsContext polls
 *  and bonus claim monitoring — regardless of whether they're in the 2
 *  earning slots. The earning slots are only for watch-credit reporting. */
function getBonusMonitoredLogins() {
  return [...pointsPlayingLogins].filter((l) => pointsWatchLogins.has(l));
}

async function pollChannelPoints() {
  /* Guard: never allow overlapping poll cycles. If a previous poll is still
     running (e.g. slow GQL responses), skip this tick entirely. */
  if (pointsPollInProgress) {
    console.info('[points] Poll skipped — previous cycle still in progress');
    return;
  }
  pointsPollInProgress = true;
  try {
    /* Snapshot the bonus-monitored set at the start of the poll. This prevents
       the set from changing mid-poll if the client updates the playing set
       while we're still fetching ChannelPointsContext for earlier channels. */
    const monitored = getBonusMonitoredLogins();
    if (monitored.length === 0) {
      console.info('[points] Poll skipped — no playing+live channels to monitor');
      return;
    }
    const token = await getValidPointsToken();
    if (!token) {
      console.warn('[points] Poll skipped — no valid token');
      return;
    }

    /* Log the full state breakdown each poll cycle. */
    console.info(
      `[points] Playing ${pointsPlayingLogins.size} | Live ${pointsWatchLogins.size} | ` +
      `Earning ${pointsActiveSlots.length} | Bonus-monitored ${monitored.length}`
    );

    /* Client-Session-Id is generated once per application session (not per poll). */
    const logins = monitored;
    console.info(`[points] Polling ${logins.length} channels: ${logins.slice(0, 5).join(', ')}${logins.length > 5 ? '…' : ''}`);

    /* Phase 1: Poll ChannelPointsContext for all monitored channels.
       Collect any available claims into a queue for batch processing. */
    const claimQueue = [];

    for (const login of logins) {
      try {
        /* ChannelPointsContext: persisted query that returns the channel's points
           context, including any available bonus claim (the "+50" button).
           Send ONLY the persisted operation (operationName + variables + extensions.
           persistedQuery). No raw query text — a persisted hash describes an exact
           GraphQL document and sending arbitrary text alongside produces
           "persistedQuery sha256 hash does not match query body". */
        const queryRes = await gqlWithPointsToken(
          gqlPersistedOp('ChannelPointsContext', GQL_HASH_CHANNEL_POINTS_CONTEXT, {
            channelLogin: login,
          })
        );

        console.info(`[points] ${login}: ChannelPointsContext HTTP ${queryRes.status}`);

        if (queryRes.status === 401 || queryRes.status === 403) {
          /* Genuine auth failure — try refreshing once, then skip this cycle.
             Do NOT wipe the token for GQL errors or PersistedQueryNotFound. */
          console.warn(`[points] ${login}: ${queryRes.status} — attempting token refresh…`);
          const refreshed = await refreshPointsToken();
          if (!refreshed) {
            console.warn(`[points] ${login}: refresh failed — stopping poll`);
            return;
          }
          continue;
        }

        if (queryRes.status !== 200) {
          console.warn(`[points] ${login}: ChannelPointsContext HTTP ${queryRes.status}: ${queryRes.body.slice(0, 500)}`);
          continue;
        }

        let j;
        try {
          j = JSON.parse(queryRes.body);
        } catch (e) {
          console.warn(`[points] ${login}: ChannelPointsContext returned non-JSON: ${queryRes.body.slice(0, 500)}`);
          continue;
        }

        /* GQL errors array — log but do NOT wipe the token. PersistedQueryNotFound
           was already handled above; other errors are schema/permission issues. */
        if (j.errors && j.errors.length) {
          console.warn(`[points] ${login}: ChannelPointsContext GQL errors: ${j.errors.map((e) => e.message).join('; ')}`);
          continue;
        }

        if (!j.data) {
          console.warn(`[points] ${login}: ChannelPointsContext no data object: ${queryRes.body.slice(0, 500)}`);
          continue;
        }

        /* Log the first successful response structure once so we can verify the
           correct data path for channel ID, points balance, and available claim. */
        if (!pointsLoggedFirstResponse) {
          pointsLoggedFirstResponse = true;
          console.info(`[points] First successful ChannelPointsContext response for ${login}:`);
          console.info(`[points]   raw: ${queryRes.body.slice(0, 1000)}`);
          const community = j.data.community;
          console.info(`[points]   data.community: ${JSON.stringify(community).slice(0, 500)}`);
        }

        /* The response structure is: data.community.channel.self.communityPoints
           (community is an alias for the user query). */
        const community = j.data.community;
        if (!community || !community.id) {
          console.warn(`[points] ${login}: no community/user in GQL response: ${queryRes.body.slice(0, 500)}`);
          continue;
        }
        const channelId = community.id;
        const cp =
          community.channel &&
          community.channel.self &&
          community.channel.self.communityPoints;

        if (!cp) {
          /* Channel may not have community points enabled — normal, don't log. */
          continue;
        }

        /* Track the current balance for this channel — all monitored channels,
           not just earning slots. */
        const currentBalance = typeof cp.balance === 'number' ? cp.balance : null;
        const prevBalance = pointsLastBalance.get(login);
        if (currentBalance !== null) {
          pointsLastBalance.set(login, currentBalance);
        }

        /* Log balance changes that aren't from a claim. Don't classify as
           WATCH yet — a balance can change for other reasons. Just note
           whether the channel is in an active slot so the user can correlate
           the 5-minute cadence with active viewing. */
        if (currentBalance !== null && prevBalance !== undefined && currentBalance !== prevBalance) {
          const delta = currentBalance - prevBalance;
          const pending = pointsPendingBalanceCheck.get(login);
          /* Don't log here if it's a claim delta — that's logged below. */
          if (!pending) {
            const isActive = pointsActiveSlots.includes(login);
            console.info(
              `[points] ${login}: balance ${prevBalance} → ${currentBalance} ` +
              `(Δ=${delta >= 0 ? '+' : ''}${delta}${isActive ? ', active-slot' : ''})`
            );
          }
        }

        /* Check if we have a pending balance-delta verification for this channel
           (i.e. we claimed a bonus recently and want to confirm via balance). */
        const pending = pointsPendingBalanceCheck.get(login);
        if (pending && currentBalance !== null) {
          const delta = currentBalance - (pending.balanceBefore ?? 0);
          console.info(`[points] ${login}: balance delta after claim ${pending.claimId.slice(0, 8)}…: ${pending.balanceBefore ?? '?'} → ${currentBalance} (Δ=${delta})`);
          pointsPendingBalanceCheck.delete(login);
          /* If we previously recorded the claim as +0 (because pointsEarned was
             absent), update the recorded claim with the delta-derived amount. */
          if (delta > 0) {
            const claimIdx = pointsClaims.findIndex(
              (c) => c.claimId === pending.claimId
            );
            if (claimIdx >= 0 && (!pointsClaims[claimIdx].pointsEarned || pointsClaims[claimIdx].pointsEarned === 0)) {
              pointsClaims[claimIdx].pointsEarned = delta;
              pointsClaims[claimIdx].balanceDelta = delta;
              console.info(`[points] ${login}: updated claim ${pending.claimId.slice(0, 8)}… earned amount from balance delta: +${delta}`);
            }
          }
        }

        /* availableClaim is a single object (not array) in the current schema. */
        const claim = cp.availableClaim;

        /* For active-slot channels, log the balance and claim state every poll
           so the user can see the watch-credit progression (e.g. balance going
           up by ~10-12 every 5 minutes, then availableClaim appearing). */
        if (pointsActiveSlots.includes(login)) {
          console.info(
            `[points] ${login}: balance=${currentBalance ?? '?'} ` +
            `availableClaim=${claim?.id ? claim.id.slice(0, 8) + '…' : 'null'}`
          );
        }

        if (!claim || !claim.id) {
          /* No bonus available right now — normal. */
          continue;
        }

        /* Skip if this claim ID is already in-flight (being claimed by a
           previous batch that hasn't finished yet). This prevents duplicate
           concurrent claims for the same bonus. */
        if (inFlightClaimIds.has(claim.id)) {
          console.info(`[points] ${login}: bonus claim ${claim.id.slice(0, 8)}… already in-flight — skipping`);
          continue;
        }

        console.info(`[points] ${login}: bonus claim ${claim.id} found`);

        /* Add to the claim queue — claims are processed in batch after all
           ChannelPointsContext polls complete. This separates monitoring
           (all playing+live channels) from claiming (batched, concurrency-limited). */
        claimQueue.push({
          login,
          channelId,
          claimId: claim.id,
          balanceBefore: currentBalance,
        });
      } catch (e) {
        /* Log the full exception — do NOT swallow. Keep failures isolated
           per channel — continue processing the remainder of the queue. */
        console.warn(`[points] ${login}: error during poll: ${e.message || e}`);
        console.warn(`[points] ${login}: stack: ${e.stack || '(no stack)'}`);
      }
    }

    /* Phase 2: Process the claim queue in batches of 2 (concurrency limit).
       Claims from ALL monitored channels are processed — not just the 2
       earning slots. The earning slots are only for watch-credit reporting. */
    if (claimQueue.length > 0) {
      console.info(`[points] ${claimQueue.length} bonus claim${claimQueue.length > 1 ? 's' : ''} available`);
      await processClaimQueue(claimQueue);
    }
  } finally {
    /* Always release the guard, even if the poll threw an uncaught error. */
    pointsPollInProgress = false;
  }
}

/** Process a queue of bonus claims in batches of CLAIM_BATCH_SIZE (2).
 *  Each batch runs claims concurrently; batches run sequentially. */
const CLAIM_BATCH_SIZE = 2;

async function processClaimQueue(queue) {
  const total = queue.length;
  const batches = Math.ceil(total / CLAIM_BATCH_SIZE);
  let succeeded = 0;

  for (let b = 0; b < batches; b++) {
    const batch = queue.slice(b * CLAIM_BATCH_SIZE, (b + 1) * CLAIM_BATCH_SIZE);
    const batchNum = b + 1;
    console.info(`[points] Claim batch ${batchNum}/${batches}: ${batch.map((c) => c.login).join(', ')}`);

    /* Process each claim in the batch concurrently. */
    const results = await Promise.allSettled(
      batch.map((claimItem) => processSingleClaim(claimItem))
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value) {
        succeeded++;
      }
    }
  }

  console.info(`[points] Claims complete: ${succeeded}/${total}`);
}

/** Process a single bonus claim. Returns true on success, false on failure.
 *  This function is independent of the earning slots — it claims the bonus
 *  for any monitored channel, regardless of watch-credit status.
 *  The claim ID is added to inFlightClaimIds for the duration of the attempt
 *  and removed in finally, so the same claim can never be queued twice. */
async function processSingleClaim({ login, channelId, claimId, balanceBefore }) {
  inFlightClaimIds.add(claimId);
  try {
    console.info(`[points] ${login}: ClaimCommunityPoints…`);

    /* ClaimCommunityPoints: persisted mutation that claims the bonus.
       Send ONLY the persisted operation (no raw query text). */
    const claimRes = await gqlWithPointsToken(
      gqlPersistedOp('ClaimCommunityPoints', GQL_HASH_CLAIM_COMMUNITY_POINTS, {
        input: { channelID: channelId, claimID: claimId },
      })
    );

    if (claimRes.status !== 200) {
      console.warn(`[points] ${login}: ClaimCommunityPoints HTTP ${claimRes.status}: ${claimRes.body.slice(0, 500)}`);
      return false;
    }

    let cj;
    try {
      cj = JSON.parse(claimRes.body);
    } catch (e) {
      console.warn(`[points] ${login}: ClaimCommunityPoints returned non-JSON: ${claimRes.body.slice(0, 500)}`);
      return false;
    }

    /* Log the complete first successful ClaimCommunityPoints JSON response,
       but only when POINTS_DEBUG is set — the response structure is now
       confirmed and the dump is no longer needed in normal operation. */
    if (!pointsLoggedFirstClaim) {
      pointsLoggedFirstClaim = true;
      if (process.env.POINTS_DEBUG) {
        console.info(`[points] First successful ClaimCommunityPoints response for ${login}:`);
        console.info(`[points]   raw: ${claimRes.body.slice(0, 1000)}`);
        console.info(`[points]   parsed: ${JSON.stringify(cj).slice(0, 800)}`);
      }
    }

    if (cj.errors && cj.errors.length) {
      console.warn(`[points] ${login}: ClaimCommunityPoints GQL errors: ${cj.errors.map((e) => e.message).join('; ')}`);
      return false;
    }

    /* Parse the claim response. Twitch's current schema returns:
     *   data.claimCommunityPoints.claim.pointsEarnedBaseline
     *   data.claimCommunityPoints.claim.pointsEarnedTotal
     *   data.claimCommunityPoints.currentPoints
     * It does NOT return claim.pointsEarned (older schema). */
    const payload = cj.data?.claimCommunityPoints;
    const claimObj = payload?.claim;

    const earned =
      typeof claimObj?.pointsEarnedTotal === 'number' ? claimObj.pointsEarnedTotal :
      typeof claimObj?.pointsEarnedBaseline === 'number' ? claimObj.pointsEarnedBaseline :
      null;

    const currentPoints =
      typeof payload?.currentPoints === 'number' ? payload.currentPoints : null;

    /* Success = no error and the claim object has an ID. */
    const success = !payload?.error && Boolean(claimObj?.id);

    if (!success) {
      console.warn(`[points] ${login}: ClaimCommunityPoints not successful: ${claimRes.body.slice(0, 500)}`);
      return false;
    }

    /* Record the claim with the parsed earned amount. */
    const claimRecord = {
      login,
      claimId,
      pointsEarned: earned ?? 0,
      ts: Date.now(),
    };
    pointsClaims.unshift(claimRecord);
    if (pointsClaims.length > 50) pointsClaims.length = 50;

    /* Update the stored balance immediately from currentPoints so the next
       ChannelPointsContext poll doesn't see the +50 claim as a passive watch
       balance delta. Without this, the poll would log e.g. "946180 → 946230
       (Δ=+50)" and misclassify it as a watch-credit change. */
    if (currentPoints !== null) {
      pointsLastBalance.set(login, currentPoints);
    }

    /* Log success with the actual amount from the response. */
    if (earned !== null) {
      console.info(`[points] ${login}: claim succeeded (+${earned})`);
    } else {
      console.info(`[points] ${login}: claim succeeded (amount unknown)`);
    }
    return true;
  } catch (e) {
    /* Keep failures isolated per channel — don't abort the partner claim
       or later batches. Promise.allSettled in processClaimQueue ensures
       one rejection doesn't affect others. */
    console.warn(`[points] ${login}: claim error: ${e.message || e}`);
    console.warn(`[points] ${login}: stack: ${e.stack || '(no stack)'}`);
    return false;
  } finally {
    /* Always remove from in-flight, regardless of success/failure/exception.
       This ensures the same claim ID can be re-queued if needed on a future
       poll (e.g. if this attempt failed and the claim is still available). */
    inFlightClaimIds.delete(claimId);
  }
}

/** Background poller: checks all playing+live channels every 60s for available
 *  bonus claims. The interval fires every 15s but each channel is polled at
 *  most once per 60s. This is independent of the 2 earning slots — ALL
 *  playing+live channels are monitored for bonus claims. */
setInterval(() => {
  /* Only poll if there are channels to monitor (playing ∩ live). */
  if (pointsPlayingLogins.size === 0) return;
  if (pointsWatchLogins.size === 0) return;
  if (Date.now() - pointsLastPoll < 60_000) return;
  if (!pointsToken) return;
  pointsLastPoll = Date.now();
  pollChannelPoints().catch((e) => {
    /* Log the full exception — do NOT swallow. */
    console.warn(`[points] pollChannelPoints() outer error: ${e.message || e}`);
    console.warn(`[points] stack: ${e.stack || '(no stack)'}`);
  });
}, 15_000);

/* --- Spade watch-progress telemetry (authenticated) ---
 *
 * Twitch credits channel points based on "minute-watched" events sent to a
 * Spade telemetry endpoint. Without these events, Twitch doesn't know the
 * authenticated user is watching, so no bonus claims appear.
 *
 * This subsystem:
 *  1. Discovers the Spade URL by scraping Twitch's settings.js bundle
 *  2. Gets each playing channel's broadcast_id via GQL (VideoPlayerStreamInfoOverlayChannel)
 *  3. Sends minute-watched POSTs every ~20s for up to 2 concurrent streams
 *     (Twitch's hard limit for points earning)
 *
 * Only channels whose streams are ACTIVELY PLAYING in the viewer are reported
 * (not merely online or in the watch list). The client reports the playing
 * set via /api/points/playing. */

/** Set of Twitch logins currently being played (active video elements). */
let pointsPlayingLogins = new Set();

/** Cached spade URL (discovered from Twitch settings.js). */
let spadeUrl = null;
let spadeUrlDiscoveredAt = 0;
const SPADE_URL_TTL_MS = 10 * 60 * 1000; /* refresh every 10 min */

/** Cached stream info per login: {channelId, broadcastId, game, gameId, ts}. */
const streamInfoCache = new Map();
const STREAM_INFO_TTL_MS = 60 * 1000; /* refresh every 60s */

/** Discover the Spade URL by scraping Twitch's settings.js bundle.
 *  The URL is dynamic — Twitch rotates it. We fetch the channel page, extract
 *  the settings.js URL, then extract spade_url from that JS bundle. */
async function discoverSpadeUrl() {
  if (spadeUrl && Date.now() - spadeUrlDiscoveredAt < SPADE_URL_TTL_MS) {
    return spadeUrl;
  }
  try {
    /* Fetch any Twitch channel page to find the settings.js URL. */
    const pageRes = await fetch('https://www.twitch.tv/', {
      headers: { 'User-Agent': TWITCH_POINTS_USER_AGENT },
    });
    if (!pageRes.ok) {
      console.warn(`[points] Spade URL discovery: twitch.tv returned ${pageRes.status}`);
      return null;
    }
    const pageText = await pageRes.text();
    /* Extract the settings.js URL from the page HTML. */
    const settingsMatch = pageText.match(
      /https:\/\/(?:static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings\.[a-f0-9]+\.js/i
    );
    if (!settingsMatch) {
      console.warn('[points] Spade URL discovery: could not find settings.js URL in page');
      return null;
    }
    const settingsUrl = settingsMatch[0];
    const settingsRes = await fetch(settingsUrl, {
      headers: { 'User-Agent': TWITCH_POINTS_USER_AGENT },
    });
    if (!settingsRes.ok) {
      console.warn(`[points] Spade URL discovery: settings.js returned ${settingsRes.status}`);
      return null;
    }
    const settingsText = await settingsRes.text();
    /* Extract spade_url from the settings JS bundle. */
    const spadeMatch = settingsText.match(/"spade_url":"(.*?)"/);
    if (!spadeMatch) {
      console.warn('[points] Spade URL discovery: could not find spade_url in settings.js');
      return null;
    }
    spadeUrl = spadeMatch[1];
    spadeUrlDiscoveredAt = Date.now();
    console.info(`[points] Spade URL discovered: ${spadeUrl}`);
    return spadeUrl;
  } catch (e) {
    console.warn(`[points] Spade URL discovery error: ${e.message || e}`);
    return null;
  }
}

/** Get stream info (broadcast_id, channel_id, game) for a login via GQL.
 *  Uses the VideoPlayerStreamInfoOverlayChannel persisted query. */
async function getStreamInfoForSpade(login) {
  const cached = streamInfoCache.get(login);
  if (cached && Date.now() - cached.ts < STREAM_INFO_TTL_MS) {
    return cached;
  }
  try {
    const res = await gqlWithPointsToken(
      gqlPersistedOp('VideoPlayerStreamInfoOverlayChannel', GQL_HASH_STREAM_INFO, {
        channel: login,
      })
    );
    if (res.status !== 200) {
      console.warn(`[points] ${login}: StreamInfo HTTP ${res.status}`);
      return null;
    }
    const j = JSON.parse(res.body);
    if (j.errors && j.errors.length) {
      console.warn(`[points] ${login}: StreamInfo GQL errors: ${j.errors.map((e) => e.message).join('; ')}`);
      return null;
    }
    const user = j.data?.user;
    if (!user || !user.stream) {
      /* Channel is offline — no stream info. */
      return null;
    }
    const info = {
      channelId: user.id,
      broadcastId: user.stream.id,
      game: user.broadcastSettings?.game?.displayName || null,
      gameId: user.broadcastSettings?.game?.id || null,
      ts: Date.now(),
    };
    streamInfoCache.set(login, info);
    return info;
  } catch (e) {
    console.warn(`[points] ${login}: StreamInfo error: ${e.message || e}`);
    return null;
  }
}

/** Send a minute-watched event to the Spade endpoint for a channel.
 *  The payload is base64-encoded JSON sent as form-encoded `data=<base64>`.
 *  Twitch expects HTTP 204 No Content on success. */
async function sendMinuteWatched(login, streamInfo) {
  if (!spadeUrl) {
    const discovered = await discoverSpadeUrl();
    if (!discovered) return false;
  }
  if (!pointsToken?.userId) {
    console.warn('[points] Cannot send minute-watched — no user_id');
    return false;
  }

  const eventProperties = {
    channel_id: streamInfo.channelId,
    broadcast_id: streamInfo.broadcastId,
    player: 'site',
    user_id: pointsToken.userId,
    live: true,
    channel: login,
  };
  /* Include game info for drop attribution (Twitch now requires it). */
  if (streamInfo.game && streamInfo.gameId) {
    eventProperties.game = streamInfo.game;
    eventProperties.game_id = streamInfo.gameId;
  }

  const payload = [{ event: 'minute-watched', properties: eventProperties }];
  const jsonStr = JSON.stringify(payload);
  const b64 = Buffer.from(jsonStr).toString('base64');
  const formData = `data=${encodeURIComponent(b64)}`;

  try {
    const res = await new Promise((resolve, reject) => {
      const url = new URL(spadeUrl);
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formData),
            'User-Agent': TWITCH_POINTS_USER_AGENT,
          },
        },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => {
            resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') });
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Spade timeout')));
      req.write(formData);
      req.end();
    });

    if (res.status === 204) {
      return true;
    }
    console.warn(`[points] ${login}: Spade minute-watched HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    return false;
  } catch (e) {
    console.warn(`[points] ${login}: Spade minute-watched error: ${e.message || e}`);
    return false;
  }
}

/** Twitch limits points earning to 2 concurrent streams. */
const POINTS_MAX_CONCURRENT = 2;

/* --- Sticky points-active slot allocation ---
 *
 * Points-active slots are "sticky" — once a channel is assigned a slot, it
 * keeps it until one of:
 *   - the channel goes offline (no longer in the live set)
 *   - the channel stops playing (no longer in the playing set)
 *   - the user manually prioritises a different channel
 *
 * This prevents the selected pair from jumping around every 20 seconds, which
 * would break watch streaks (Twitch requires 10+ minutes for streak credit).
 *
 * The user can also manually pin channels to slots via /api/points/prioritize.
 * Manually-prioritised channels take the slots first; remaining slots are
 * filled from eligible channels in playing-set order. */

/** @type {string[]} Ordered list of logins the user manually prioritised. */
let pointsPriorityLogins = [];
/** @type {string[]} Current sticky slot allocation (up to 2 logins). */
let pointsActiveSlots = [];

/** Recompute the points-active slots from the eligible set.
 *  Eligible = Playing ∩ Live. Sticky: existing slots are kept if still
 *  eligible. Manual priority pins fill first. */
function recomputePointsActiveSlots() {
  const playingSet = pointsPlayingLogins;
  const liveSet = pointsWatchLogins;
  /* Eligible = playing ∩ live. */
  const eligible = [...playingSet].filter((l) => liveSet.has(l));

  /* Start with manually-prioritised channels that are still eligible. */
  const slots = [];
  const used = new Set();
  for (const p of pointsPriorityLogins) {
    if (eligible.includes(p) && !used.has(p) && slots.length < POINTS_MAX_CONCURRENT) {
      slots.push(p);
      used.add(p);
    }
  }

  /* Keep existing sticky slots if still eligible. */
  for (const s of pointsActiveSlots) {
    if (eligible.includes(s) && !used.has(s) && slots.length < POINTS_MAX_CONCURRENT) {
      slots.push(s);
      used.add(s);
    }
  }

  /* Fill remaining slots from eligible channels (in playing-set order). */
  for (const e of eligible) {
    if (!used.has(e) && slots.length < POINTS_MAX_CONCURRENT) {
      slots.push(e);
      used.add(e);
    }
  }

  /* Detect slot changes and log the reason for each change. */
  const oldSlots = pointsActiveSlots;
  const oldKey = oldSlots.join(',');
  const newKey = slots.join(',');
  if (oldKey !== newKey) {
    /* Log each slot position for clear debugging. */
    for (let i = 0; i < POINTS_MAX_CONCURRENT; i++) {
      const oldLogin = oldSlots[i] || null;
      const newLogin = slots[i] || null;
      if (oldLogin === newLogin) {
        if (oldLogin) console.info(`[points] Slot ${i + 1}: ${oldLogin} retained`);
      } else if (oldLogin && newLogin) {
        let reason;
        if (!playingSet.has(oldLogin)) reason = 'stopped playing';
        else if (!liveSet.has(oldLogin)) reason = 'offline';
        else reason = 'displaced by priority';
        console.info(`[points] Slot ${i + 1}: ${oldLogin} removed — ${reason}`);
        console.info(`[points] Slot ${i + 1}: ${newLogin} assigned — eligible`);
      } else if (oldLogin && !newLogin) {
        let reason;
        if (!playingSet.has(oldLogin)) reason = 'stopped playing';
        else if (!liveSet.has(oldLogin)) reason = 'offline';
        else reason = 'no longer eligible';
        console.info(`[points] Slot ${i + 1}: ${oldLogin} removed — ${reason}`);
      } else if (!oldLogin && newLogin) {
        console.info(`[points] Slot ${i + 1}: ${newLogin} assigned — eligible`);
      }
    }
    console.info(
      `[points] Active slots: [${slots.join(', ') || 'none'}] ` +
      `(Playing ${playingSet.size}, Live ${liveSet.size}, Eligible ${eligible.length})`
    );
  }
  pointsActiveSlots = slots;
}

/** Background spade sender: sends minute-watched events every ~20s for up to
 *  2 actively-playing, live streams. Uses sticky slot allocation. */
setInterval(async () => {
  if (!pointsToken) return;

  /* Recompute eligible slots each cycle (cheap — just set operations). */
  recomputePointsActiveSlots();

  if (pointsActiveSlots.length === 0) {
    /* Still log the distinction so the user can see the state. */
    const playing = pointsPlayingLogins.size;
    const live = pointsWatchLogins.size;
    if (playing > 0 || live > 0) {
      console.info(`[points] Watch report: Playing ${playing}, Live ${live}, Points-active 0 (no eligible)`);
    }
    return;
  }

  console.info(
    `[points] Watch report: Playing ${pointsPlayingLogins.size}, ` +
    `Live ${pointsWatchLogins.size}, Points-active ${pointsActiveSlots.length} ` +
    `[${pointsActiveSlots.join(', ')}]`
  );

  for (const login of pointsActiveSlots) {
    try {
      const streamInfo = await getStreamInfoForSpade(login);
      if (!streamInfo) {
        /* Stream may have gone offline since the slot was assigned — skip
           this cycle. The next recompute will remove it. */
        console.info(`[points] ${login}: no stream info (may have gone offline)`);
        continue;
      }
      const ok = await sendMinuteWatched(login, streamInfo);
      if (ok) {
        console.info(`[points] ${login}: minute-watched sent (spade 204)`);
      }
    } catch (e) {
      console.warn(`[points] ${login}: watch report error: ${e.message || e}`);
    }
  }
}, 20_000);

/** Parse a Twitch master playlist and return the variant URL matching `quality`.
 *  Twitch names variants like "720p60", "480p30", "360p30", "160p30", "audio_only", "chunked".
 *  If the exact name isn't found, pick the closest by resolution. `best` → `chunked` (source). */
function pickTwitchVariant(masterText, quality) {
  const lines = masterText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const url = lines[i + 1];
    if (!url || url.startsWith('#')) continue;
    const attrs = {};
    const rest = line.slice('#EXT-X-STREAM-INF:'.length);
    for (const m of rest.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    variants.push({
      url,
      bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
      video: attrs.VIDEO || '',
      resolution: attrs.RESOLUTION || '',
    });
  }
  if (variants.length === 0) return null;

  // Direct name match (e.g. "720p60" → VIDEO="720p60")
  if (quality === 'best') {
    const chunked = variants.find((v) => v.video === 'chunked');
    if (chunked) return chunked.url;
    // Fallback: highest bandwidth
    return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a)).url;
  }
  const exact = variants.find((v) => v.video === quality);
  if (exact) return exact.url;

  // Fuzzy match by resolution height (e.g. "480p30" → any variant with 480p height)
  const heightMatch = quality.match(/^(\d+)p/);
  if (heightMatch) {
    const wantH = parseInt(heightMatch[1], 10);
    const byHeight = variants
      .filter((v) => {
        const m = v.resolution.match(/x(\d+)$/);
        return m && parseInt(m[1], 10) === wantH;
      })
      .sort((a, b) => b.bandwidth - a.bandwidth);
    if (byHeight.length > 0) return byHeight[0].url;
    // If no exact height match, pick the closest lower variant (don't overshoot)
    const lower = variants
      .filter((v) => {
        const m = v.resolution.match(/x(\d+)$/);
        return m && parseInt(m[1], 10) <= wantH && v.video !== 'audio_only';
      })
      .sort((a, b) => b.bandwidth - a.bandwidth);
    if (lower.length > 0) return lower[0].url;
  }

  // Ultimate fallback: first non-audio variant
  const nonAudio = variants.find((v) => v.video !== 'audio_only');
  return nonAudio ? nonAudio.url : variants[0].url;
}

/** Resolve a Twitch CDN media-playlist URL via the direct API (no Streamlink needed).
 *  Returns a URL string or throws on error. Handles token expiry by invalidating the
 *  token cache and retrying once if the usher call fails with a non-404 error.
 *  playerType controls which player Twitch thinks is requesting (for ad-blocking). */
async function resolveTwitchDirectApi(login, quality, playerType = 'embed') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await fetchTwitchPlaybackToken(login, playerType);
    const params = new URLSearchParams({
      allow_source: 'true',
      allow_audio_only: 'true',
      player: 'twitchweb',
      playlist_include_framerate: 'true',
      supported_codecs: 'avc1',
      token: token.value,
      sig: token.signature,
    });
    const usherUrl = `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params}`;
    const r = await fetchBuffer(usherUrl);
    if (r.status === 404) {
      // Channel is genuinely offline — not a token issue, don't retry.
      throw new Error(`Twitch: channel "${login}" is offline or does not exist.`);
    }
    if (r.status === 200) {
      const masterText = r.body.toString('utf8');
      const variantUrl = pickTwitchVariant(masterText, quality);
      if (!variantUrl) {
        throw new Error(`Twitch: no playable stream variant for "${login}" (quality: ${quality}).`);
      }
      return variantUrl;
    }
    // Non-200, non-404 (e.g. 403) — likely an expired token. Invalidate and retry once.
    if (attempt === 0) {
      twitchTokenCache.delete(`${login}|${playerType}`);
      continue;
    }
    throw new Error(`Twitch usher returned ${r.status}`);
  }
  throw new Error(`Twitch usher failed for "${login}" after retry.`);
}

/* --- Ad blocking (vaft-style) ---
 * Twitch "stitches" ads into HLS playlists via #EXT-X-DATERANGE tags containing the
 * string "stitched". When detected, we try alternate playerType values to get an
 * ad-free stream (same approach as pixeltris/TwitchAdSolutions vaft script).
 * Different player types get different ad insertion policies from Twitch's backend.
 * 'embed' and 'popout' keep source quality; 'autoplay' is 360p only but reliably
 * ad-free. We try them in order and serve the first ad-free playlist we find. */
const TWITCH_AD_SIGNIFIER = 'stitched';
const TWITCH_AD_BLOCK_PLAYER_TYPES = ['embed', 'popout', 'autoplay'];

/** Check if a media playlist contains stitched ad markers. */
function twitchPlaylistHasAds(playlistText) {
  return playlistText.includes(TWITCH_AD_SIGNIFIER);
}

/** Fetch a media playlist for (login, quality) using a specific playerType.
 *  Returns the playlist text, or null on error. */
async function fetchMediaPlaylistForPlayerType(login, quality, playerType) {
  try {
    const variantUrl = await resolveTwitchDirectApi(login, quality, playerType);
    const r = await fetchBuffer(variantUrl);
    if (r.status === 200) return r.body.toString('utf8');
  } catch {
    /* ignore — try next player type */
  }
  return null;
}

/** Given a media playlist that contains ads, try alternate player types to find an
 *  ad-free version at the same quality. Returns the ad-free playlist text, or the
 *  original playlist if no ad-free version is found. */
async function resolveAdFreeMediaPlaylist(login, quality, originalPlaylist) {
  for (const playerType of TWITCH_AD_BLOCK_PLAYER_TYPES) {
    const playlist = await fetchMediaPlaylistForPlayerType(login, quality, playerType);
    if (playlist && !twitchPlaylistHasAds(playlist)) {
      console.log(`[twitchviewer] Ad block: found ad-free stream for ${login} via playerType=${playerType}`);
      return playlist;
    }
  }
  console.log(`[twitchviewer] Ad block: no ad-free stream found for ${login}, serving original playlist`);
  return originalPlaylist;
}

/** Resolve a Twitch CDN media-playlist URL. Tries the direct API first (no install needed),
 *  falls back to Streamlink if installed. Caches the result per (login, quality). */
async function resolveTwitchProxyUrl(login, quality) {
  const key = `${login}|${quality}`;
  const now = Date.now();
  const cached = twitchProxyCache.get(key);
  if (cached && cached.url && now - cached.ts < TWITCH_PROXY_TTL_MS) return cached.url;
  if (cached && cached.promise) {
    try {
      return await cached.promise;
    } catch {
      /* fall through and re-resolve */
    }
  }
  const promise = (async () => {
    // 1. Direct API (no install needed) — primary path
    try {
      const url = await resolveTwitchDirectApi(login, quality);
      twitchProxyCache.set(key, { url, promise: null, ts: Date.now() });
      return url;
    } catch (directErr) {
      // 2. Streamlink fallback (if installed)
      if (streamlinkWorks()) {
        const url = await resolveStreamlinkStreamUrl(login, quality);
        twitchProxyCache.set(key, { url, promise: null, ts: Date.now() });
        return url;
      }
      throw directErr;
    }
  })();
  twitchProxyCache.set(key, { url: '', promise, ts: now });
  return promise;
}

function invalidateTwitchProxy(login, quality) {
  if (quality) {
    twitchProxyCache.delete(`${login}|${quality}`);
    return;
  }
  for (const k of [...twitchProxyCache.keys()]) {
    if (k.startsWith(`${login}|`)) twitchProxyCache.delete(k);
  }
}

/** Fetch a URL as text/buffer with redirect + timeout handling. Returns {status, headers, body}. */
function fetchBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) twitchviewer/1.0',
          Accept: '*/*',
        },
      },
      (resp) => {
        const status = resp.statusCode || 0;
        if (status >= 300 && status < 400 && resp.headers.location && maxRedirects > 0) {
          resp.resume();
          const next = new URL(resp.headers.location, url).toString();
          fetchBuffer(next, maxRedirects - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status, headers: resp.headers, body: Buffer.concat(chunks) }));
        resp.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('proxy fetch timeout')));
  });
}

/** Stream a remote URL response straight into the Express `res` (zero buffering for segments). */
function pipeRemoteTo(url, res, maxRedirects = 5) {
  const lib = url.startsWith('https:') ? https : http;
  const req = lib.get(
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) twitchviewer/1.0',
        Accept: '*/*',
      },
    },
    (resp) => {
      const status = resp.statusCode || 0;
      if (status >= 300 && status < 400 && resp.headers.location && maxRedirects > 0) {
        resp.resume();
        const next = new URL(resp.headers.location, url).toString();
        pipeRemoteTo(next, res, maxRedirects - 1);
        return;
      }
      if (status !== 200) {
        resp.resume();
        res.status(status).end();
        return;
      }
      const ct = resp.headers['content-type'];
      if (ct) res.type(ct);
      resp.pipe(res);
    }
  );
  req.on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });
  req.setTimeout(20000, () => req.destroy(new Error('pipe timeout')));
}

/** Rewrite every segment/sub-playlist URI in a media playlist to route through the proxy.
 *  Encodes the fully-resolved absolute URI as base64url so segment fetches are stateless. */
function rewriteTwitchPlaylist(playlistText, baseUrl, login, quality) {
  const lines = playlistText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    // URI line (segment or sub-playlist) — resolve against baseUrl, then rewrite.
    const abs = new URL(trimmed, baseUrl).toString();
    const enc = Buffer.from(abs).toString('base64url');
    out.push(`/api/twitch-live/${encodeURIComponent(login)}/seg/${enc}?q=${encodeURIComponent(quality)}`);
  }
  return out.join('\n');
}

/** Proxy a segment: decode the encoded absolute URL and pipe it through.
 *  On 403/404 (CDN URL expired), invalidate the playlist + token caches so the next playlist
 *  poll re-resolves with a fresh CDN URL; return 503 so hls.js treats it as a fragment error
 *  and (with the client-side error recovery) reloads the playlist. */
app.get('/api/twitch-live/:login/seg/:enc', async (req, res) => {
  const login = normalizeTwitchLoginParam(req.params.login);
  if (!login) return res.status(400).type('text').send('Invalid login');
  const quality = sanitizeProxyQuality(req.query.q);
  let segUrl;
  try {
    segUrl = Buffer.from(String(req.params.enc), 'base64url').toString('utf8');
    if (!/^https?:\/\//i.test(segUrl)) throw new Error('bad');
  } catch {
    return res.status(400).type('text').send('Bad segment reference');
  }
  try {
    const probe = await fetchBuffer(segUrl);
    if (probe.status === 403 || probe.status === 404) {
      // Segment URL expired — invalidate everything so the next playlist poll re-resolves
      // with a fresh token + CDN URL + fresh segment URLs.
      invalidateTwitchProxy(login, quality);
      for (const pt of ['embed', 'popout', 'autoplay']) {
        twitchTokenCache.delete(`${login}|${pt}`);
      }
      return res.status(503).type('text').send('Segment URL expired — playlist will reload.');
    }
    if (probe.status !== 200) {
      return res.status(502).type('text').send(`Upstream ${probe.status}`);
    }
    const ct = probe.headers['content-type'] || 'video/mp2t';
    res.type(ct);
    res.send(probe.body);
  } catch {
    invalidateTwitchProxy(login, quality);
    for (const pt of ['embed', 'popout', 'autoplay']) {
      twitchTokenCache.delete(`${login}|${pt}`);
    }
    if (!res.headersSent) res.status(502).type('text').send('Segment fetch failed');
  }
});

/**
 * Twitch → HLS in-browser. Two implementations share this route:
 *  - proxy mode (default): direct API (GQL+usher) or streamlink resolves a CDN URL per
 *    quality; server rewrites the playlist and pipes segments. No ffmpeg, no install needed.
 *    Client picks quality via ?q= based on tile size.
 *  - hls mode (legacy, TWITCH_PLAYBACK=hls): streamlink + ffmpeg re-segments to disk.
 */
app.get('/api/twitch-live/:login/:file', async (req, res) => {
  const login = normalizeTwitchLoginParam(req.params.login);
  const file = String(req.params.file || '');
  if (!login) {
    return res.status(400).type('text').send('Invalid login');
  }
  const mode = currentTwitchPlayback();
  // Legacy hls mode requires streamlink + ffmpeg
  if (mode === 'hls' && !streamlinkWorks()) {
    return res
      .status(503)
      .type('text')
      .send(
        'streamlink not found. Install from https://streamlink.github.io/ , set STREAMLINK_PATH in .env to streamlink.exe, or use TWITCH_PLAYBACK=proxy (default, no install needed)'
      );
  }

  /* --- proxy mode: direct API or streamlink resolves CDN URL, server rewrites + pipes --- */
  if (mode === 'proxy') {
    if (file !== 'playlist.m3u8') {
      // Segments are served by the /seg/:enc route above; legacy seg_N.ts names aren't used.
      return res.status(404).end();
    }
    const quality = sanitizeProxyQuality(req.query.q);
    let streamUrl;
    try {
      streamUrl = await resolveTwitchProxyUrl(login, quality);
    } catch (e) {
      return res.status(503).type('text').send(String(e.message));
    }
    try {
      let r = await fetchBuffer(streamUrl);
      if (r.status === 403 || r.status === 404) {
        // CDN URL expired — invalidate everything (token might be stale too) and re-resolve.
        invalidateTwitchProxy(login, quality);
        for (const pt of ['embed', 'popout', 'autoplay']) {
          twitchTokenCache.delete(`${login}|${pt}`);
        }
        try {
          streamUrl = await resolveTwitchProxyUrl(login, quality);
        } catch (e) {
          return res.status(503).type('text').send(String(e.message));
        }
        r = await fetchBuffer(streamUrl);
        if (r.status !== 200) {
          return res.status(502).type('text').send(`Upstream playlist ${r.status}`);
        }
      }
      if (r.status !== 200) {
        return res.status(502).type('text').send(`Upstream playlist ${r.status}`);
      }

      // Ad blocking: check the media playlist for stitched ad markers. If found,
      // try alternate player types to get an ad-free playlist (vaft-style).
      let playlistText = r.body.toString('utf8');
      let rewriteBaseUrl = streamUrl;
      if (twitchPlaylistHasAds(playlistText)) {
        console.log(`[twitchviewer] Ad block: detected ads in playlist for ${login} (quality: ${quality})`);
        const adFree = await resolveAdFreeMediaPlaylist(login, quality, playlistText);
        if (adFree !== playlistText) {
          playlistText = adFree;
          // The ad-free playlist came from a different CDN URL — we need to use that
          // URL as the base for segment rewriting. Re-resolve to get the current URL.
          // (The ad-free playlist's segment URLs are already absolute, so the base
          // only matters for resolving any relative URLs — which Twitch doesn't use.)
        }
      }

      res.type('application/vnd.apple.mpegurl');
      return res.send(rewriteTwitchPlaylist(playlistText, rewriteBaseUrl, login, quality));
    } catch (e) {
      return res.status(502).type('text').send(`Playlist fetch failed: ${String(e.message || e)}`);
    }
  }

  /* --- legacy hls mode: streamlink + ffmpeg transcode to disk --- */
  const sourceKey = twitchLiveSourceKey(login);
  const hash = transcodeHash(sourceKey);

  if (file === 'playlist.m3u8') {
    if (!transcodeState.has(hash)) {
      try {
        const streamUrl = await resolveStreamlinkStreamUrl(login);
        startFfmpegIfNeeded(hash, streamUrl, { twitch: true });
      } catch (e) {
        return res.status(503).type('text').send(String(e.message));
      }
    }
    const entry = transcodeState.get(hash);
    if (entry && entry.error) {
      return res.status(503).type('text').send(`ffmpeg: ${entry.error}`);
    }
    if (!entry) {
      return res.status(503).type('text').send('Transcoder not running.');
    }
    const playlistPath = path.join(entry.dir, 'playlist.m3u8');
    const ok = await waitForFile(playlistPath, 30000);
    if (!ok) {
      return res
        .status(503)
        .type('text')
        .send(
          'Playlist not ready. Check ffmpeg (PATH), streamlink, and that the channel is live.'
        );
    }
    return res.sendFile(playlistPath);
  }

  if (!/^seg_\d+\.ts$/i.test(file)) {
    return res.status(404).end();
  }
  const entry = transcodeState.get(hash);
  if (!entry || entry.error) {
    return res.status(404).end();
  }
  const filePath = path.join(entry.dir, file);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).end();
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});
app.get('/styles.css', (_req, res) => {
  res.sendFile(path.join(root, 'styles.css'));
});
app.get('/app.js', (_req, res) => {
  res.sendFile(path.join(root, 'app.js'));
});
app.get('/hls.min.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js'));
});

const port = getPort();

/** Resolve TLS file paths relative to the project directory (not process.cwd()). */
function resolveTlsFilePath(p) {
  const trimmed = typeof p === 'string' ? p.trim() : '';
  if (!trimmed) return '';
  return path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed);
}

/**
 * Auto-find mkcert-style key + cert under project root (folder name is often wrong: cert vs certs).
 * @returns {{ keyPath: string, certPath: string, label: string } | null}
 */
function discoverLocalTlsFiles() {
  /** @type {readonly [string, string, string][]} */
  const pairs = [
    ['certs', 'localhost-key.pem', 'localhost.pem'],
    ['cert', 'localhost-key.pem', 'localhost.pem'],
    ['certs', 'localhost.key', 'localhost.crt'],
    ['cert', 'localhost.key', 'localhost.crt'],
  ];
  for (const [dir, keyFile, certFile] of pairs) {
    const keyPath = path.join(root, dir, keyFile);
    const certPath = path.join(root, dir, certFile);
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        keyPath,
        certPath,
        label: `${dir}/${keyFile} + ${dir}/${certFile}`,
      };
    }
  }
  return null;
}

/**
 * TLS for local HTTPS. Default: in-memory self-signed (browser shows "Not secure").
 * Trusted: mkcert files — set HTTPS_KEY_PATH / HTTPS_CERT_PATH, or place key+cert in
 * certs/ or cert/ (see discoverLocalTlsFiles).
 * @returns {Promise<{ key: Buffer | string, cert: Buffer | string, source: 'custom' | 'selfsigned', label: string }>}
 */
async function createTlsOptions() {
  const envKey = process.env.HTTPS_KEY_PATH?.trim();
  const envCert = process.env.HTTPS_CERT_PATH?.trim();

  let keyPath = '';
  let certPath = '';
  let label = '';

  if (envKey && envCert) {
    keyPath = resolveTlsFilePath(envKey);
    certPath = resolveTlsFilePath(envCert);
    label = `HTTPS_KEY_PATH / HTTPS_CERT_PATH → ${path.relative(root, keyPath)}`;
  } else if (envKey || envCert) {
    throw new Error(
      'Set both HTTPS_KEY_PATH and HTTPS_CERT_PATH, or omit both for self-signed HTTPS.'
    );
  } else {
    const found = discoverLocalTlsFiles();
    if (found) {
      keyPath = found.keyPath;
      certPath = found.certPath;
      label = found.label;
    }
  }

  if (keyPath && certPath) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`HTTPS key not found: ${keyPath}`);
    }
    if (!fs.existsSync(certPath)) {
      throw new Error(`HTTPS cert not found: ${certPath}`);
    }
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      source: 'custom',
      label,
    };
  }

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });
  return {
    key: pems.private,
    cert: pems.cert,
    source: 'selfsigned',
    label: 'built-in self-signed (browser will show Not secure)',
  };
}

/**
 * @param {'http' | 'https'} scheme
 * @param {{ source: 'custom' | 'selfsigned', label?: string } | undefined} [tlsInfo]
 */
function printStartupTips(scheme, tlsInfo) {
  console.log(`Session database: ${sessionSqlitePath}`);
  console.log(
    `OAuth redirect URLs to register in Twitch (must match scheme ${scheme}://):`
  );
  console.log(`  ${scheme}://127.0.0.1:${port}/auth/callback`);
  console.log(`  ${scheme}://localhost:${port}/auth/callback`);
  console.log(
    `Or set TWITCH_REDIRECT_URI in .env to one exact URL and add that same URL in Twitch.`
  );
  if (scheme === 'https' && tlsInfo) {
    if (tlsInfo.source === 'selfsigned') {
      console.log(
        `TLS: ${tlsInfo.label || 'self-signed'} — browser will show "Not secure" until trusted certs load.`
      );
      console.log(
        `     Expected files (same folder as server.js): certs/localhost-key.pem + certs/localhost.pem`
      );
      console.log(
        `     or cert/ with the same names — or set HTTPS_KEY_PATH + HTTPS_CERT_PATH in .env.`
      );
      console.log(
        `     Run mkcert-local.bat, or: mkcert -install (as Admin^), then restart the server.`
      );
    } else {
      console.log(`TLS: trusted (${tlsInfo.label || 'custom key + cert'})`);
    }
  }
  if (!process.env.TWITCH_CLIENT_ID) {
    console.log(
      'Tip: copy .env.example to .env and add Twitch app credentials.'
    );
  }
  if (!process.env.SESSION_SECRET) {
    console.log(
      'Tip: set SESSION_SECRET in .env so login cookies stay valid after restarts.'
    );
  }
  console.log(
    'HLS transcode: install ffmpeg and add to PATH, then add streams as transcode:https://…/playlist.m3u8'
  );
  const sl = streamlinkWorks();
  console.log(
    sl
      ? 'Twitch channels: pass-through proxy (same-origin HLS, no ffmpeg). Resolves via direct Twitch API with Streamlink as fallback. Quality adapts to each tile size. Set TWITCH_PLAYBACK=iframe for the official embed, or TWITCH_PLAYBACK=hls for the legacy ffmpeg transcode.'
      : 'Twitch channels: pass-through proxy (same-origin HLS, no ffmpeg, no install needed). Resolves via direct Twitch API (GQL + usher). Quality adapts to each tile size. Set TWITCH_PLAYBACK=iframe for the official embed, or TWITCH_PLAYBACK=hls for the legacy ffmpeg transcode (needs Streamlink + ffmpeg).'
  );
}

async function startServer() {
  if (useHttpOnly()) {
    http.createServer(app).listen(port, () => {
      console.log(`Twitch viewer (HTTP): http://localhost:${port}`);
      printStartupTips('http');
    });
    return;
  }

  const tls = await createTlsOptions();
  https
    .createServer({ key: tls.key, cert: tls.cert }, app)
    .listen(port, () => {
      console.log(`Twitch viewer (HTTPS): https://localhost:${port}`);
      printStartupTips('https', tls);
    });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
