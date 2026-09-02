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

/** Get recent claims + current watch list. */
app.get('/api/points/status', (_req, res) => {
  res.json({
    linked: Boolean(pointsToken?.accessToken),
    login: pointsToken?.login || null,
    claims: pointsClaims.slice(0, 20),
    watching: [...pointsWatchLogins],
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
 * with the Android TV client_id (kd1unb4b3q4t58fwlpcbzcbnm76a8fp), which is the
 * same approach used by TwitchChannelPointsMiner and similar tools. The user
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

/** Twitch's Android TV client_id — used for the device code flow because GQL
 *  only accepts tokens issued by Twitch's own clients, not developer apps. */
const TWITCH_ANDROID_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';

/* --- Persisted GQL operation hashes ---
 * These are Twitch's internal persisted-query hashes. If Twitch changes their
 * GQL schema, these hashes may need updating. Source: TwitchChannelPointsMiner
 * (Tkd-Alex/Twitch-Channel-Points-Miner-v2, master branch).
 *
 * If Twitch returns PersistedQueryNotFound, the standard persisted-query
 * protocol requires the client to retry with the full query text included
 * alongside the hash — Twitch then caches the query for future use. The raw
 * query text for each operation is included below as a fallback. */
const GQL_HASH_CHANNEL_POINTS_CONTEXT = '9988086babc615a918a1e9a722ff41d98847acac822645209ac7379eecb27152';
const GQL_HASH_CLAIM_COMMUNITY_POINTS = '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0';

/* Raw query text for fallback when PersistedQueryNotFound is returned.
 * ChannelPointsContext uses a raw query (not persisted) in some miner forks,
 * so we include the full text. ClaimCommunityPoints is persisted in all known
 * implementations, but we include the text for safety. */
const GQL_RAW_CHANNEL_POINTS_CONTEXT = `query ChannelPointsContext($channelLogin: String!) {
  community: user(login: $channelLogin) {
    id
    channel {
      self {
        communityPoints {
          balance
          activeMultipliers { factor }
          availableClaim { id }
        }
      }
    }
  }
}`;
const GQL_RAW_CLAIM_COMMUNITY_POINTS = `mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
  claimCommunityPoints(input: $input) {
    claim {
      id
      pointsEarned
    }
  }
}`;

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

/** Build a GQL operation with both the query text and the persisted-query
 *  extension. This is sent as a fallback when Twitch returns
 *  PersistedQueryNotFound — Twitch caches the query text against the hash
 *  so subsequent requests can use the hash alone. */
function gqlPersistedOpWithText(operationName, sha256Hash, queryText, variables) {
  return {
    operationName,
    variables,
    query: queryText,
    extensions: {
      persistedQuery: { version: 1, sha256Hash },
    },
  };
}

/** Check if a GQL response contains a PersistedQueryNotFound error. */
function isPersistedQueryNotFound(body) {
  try {
    const j = JSON.parse(body);
    return Array.isArray(j.errors) && j.errors.some(
      (e) => e.message === 'PersistedQueryNotFound' ||
             (typeof e.message === 'string' && e.message.includes('PersistedQueryNotFound'))
    );
  } catch {
    return false;
  }
}

/** Generate a random hex string of the given length (for device IDs). */
function randomHexId(length) {
  const bytes = crypto.randomBytes(Math.ceil(length / 2));
  return bytes.toString('hex').slice(0, length);
}

/* --- First-party device identifiers ---
 * Twitch's web/TV clients send persistent device + session IDs with GQL calls.
 * We generate and persist these to mimic a real first-party client, which helps
 * avoid Twitch flagging GQL requests as suspicious. */
const pointsDeviceIdPath = path.join(sessionSqliteDir, 'points-device-id.txt');
let pointsDeviceId = (() => {
  try { return fs.readFileSync(pointsDeviceIdPath, 'utf8').trim(); } catch { return null; }
})();
if (!pointsDeviceId) {
  pointsDeviceId = randomHexId(32);
  try { fs.writeFileSync(pointsDeviceIdPath, pointsDeviceId); } catch { /* ignore */ }
}
/** Per-poll session ID (regenerated each poll cycle, like Twitch's web client). */
let pointsClientSessionId = randomHexId(16);

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

/** @type {{accessToken: string, refreshToken: string, expiresAt: number, login: string} | null} */
let pointsToken = loadPointsToken();

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
      client_id: TWITCH_ANDROID_CLIENT_ID,
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
      client_id: TWITCH_ANDROID_CLIENT_ID,
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
  try {
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        'Client-ID': TWITCH_ANDROID_CLIENT_ID,
      },
    });
    if (userRes.ok) {
      const userBody = await userRes.json();
      login = userBody.data?.[0]?.login || 'unknown';
    } else {
      console.warn(`[points] Helix user lookup failed (${userRes.status}) — token is valid but login unknown`);
    }
  } catch (e) {
    console.warn(`[points] Helix user lookup error: ${e.message} — token is valid but login unknown`);
  }

  pointsToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    /* Twitch's Android client doesn't return expires_in — assume a long-lived
       token (~60 days). We'll refresh on 401 instead of proactively. */
    expiresAt: Date.now() + ((data.expires_in || 5184000) * 1000),
    login,
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
        client_id: TWITCH_ANDROID_CLIENT_ID,
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
      /* Twitch's Android client doesn't return expires_in — assume long-lived. */
      expiresAt: Date.now() + ((data.expires_in || 5184000) * 1000),
      login: pointsToken.login,
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
          'Client-ID': TWITCH_ANDROID_CLIENT_ID,
          Authorization: `OAuth ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          /* First-party headers that Twitch's web/TV clients send with GQL
             calls. These help avoid Twitch flagging requests as suspicious. */
          'X-Device-Id': pointsDeviceId,
          'Client-Session-Id': pointsClientSessionId,
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

async function pollChannelPoints() {
  if (pointsWatchLogins.size === 0) {
    console.info('[points] Poll skipped — no channels in watch list');
    return;
  }
  const token = await getValidPointsToken();
  if (!token) {
    console.warn('[points] Poll skipped — no valid token');
    return;
  }
  /* Regenerate session ID for each poll cycle (like Twitch's web client). */
  pointsClientSessionId = randomHexId(16);
  const logins = [...pointsWatchLogins];
  console.info(`[points] Polling ${logins.length} channels: ${logins.slice(0, 5).join(', ')}${logins.length > 5 ? '…' : ''}`);

  for (const login of logins) {
    try {
      /* ChannelPointsContext: persisted query that returns the channel's points
         context, including any available bonus claim (the "+50" button).
         Send hash-only first; if Twitch returns PersistedQueryNotFound, retry
         with the full query text included (standard persisted-query protocol). */
      let queryRes = await gqlWithPointsToken(
        gqlPersistedOp('ChannelPointsContext', GQL_HASH_CHANNEL_POINTS_CONTEXT, {
          channelLogin: login,
        })
      );

      if (queryRes.status === 200 && isPersistedQueryNotFound(queryRes.body)) {
        console.info(`[points] ${login}: PersistedQueryNotFound — retrying with full query text`);
        queryRes = await gqlWithPointsToken(
          gqlPersistedOpWithText(
            'ChannelPointsContext',
            GQL_HASH_CHANNEL_POINTS_CONTEXT,
            GQL_RAW_CHANNEL_POINTS_CONTEXT,
            { channelLogin: login }
          )
        );
      }

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

      /* availableClaim is a single object (not array) in the current schema. */
      const claim = cp.availableClaim;
      if (!claim || !claim.id) {
        /* No bonus available right now — normal. */
        continue;
      }

      console.info(`[points] ${login}: bonus claim ${claim.id} found`);
      console.info(`[points] ${login}: ClaimCommunityPoints…`);

      /* ClaimCommunityPoints: persisted mutation that claims the bonus.
         Same PersistedQueryNotFound fallback as above. */
      let claimRes = await gqlWithPointsToken(
        gqlPersistedOp('ClaimCommunityPoints', GQL_HASH_CLAIM_COMMUNITY_POINTS, {
          input: { channelID: channelId, claimID: claim.id },
        })
      );

      if (claimRes.status === 200 && isPersistedQueryNotFound(claimRes.body)) {
        console.info(`[points] ${login}: ClaimCommunityPoints PersistedQueryNotFound — retrying with full query text`);
        claimRes = await gqlWithPointsToken(
          gqlPersistedOpWithText(
            'ClaimCommunityPoints',
            GQL_HASH_CLAIM_COMMUNITY_POINTS,
            GQL_RAW_CLAIM_COMMUNITY_POINTS,
            { input: { channelID: channelId, claimID: claim.id } }
          )
        );
      }

      if (claimRes.status !== 200) {
        console.warn(`[points] ${login}: ClaimCommunityPoints HTTP ${claimRes.status}: ${claimRes.body.slice(0, 500)}`);
        continue;
      }

      let cj;
      try {
        cj = JSON.parse(claimRes.body);
      } catch (e) {
        console.warn(`[points] ${login}: ClaimCommunityPoints returned non-JSON: ${claimRes.body.slice(0, 500)}`);
        continue;
      }

      if (cj.errors && cj.errors.length) {
        console.warn(`[points] ${login}: ClaimCommunityPoints GQL errors: ${cj.errors.map((e) => e.message).join('; ')}`);
        continue;
      }

      if (!cj.data || !cj.data.claimCommunityPoints) {
        console.warn(`[points] ${login}: ClaimCommunityPoints no data object: ${claimRes.body.slice(0, 500)}`);
        continue;
      }

      const earned = cj.data.claimCommunityPoints.claim?.pointsEarned || 0;
      console.info(`[points] ${login}: claimed +${earned}`);
      pointsClaims.unshift({ login, pointsEarned: earned, ts: Date.now() });
      if (pointsClaims.length > 50) pointsClaims.length = 50;
    } catch (e) {
      /* Log the full exception — do NOT swallow. */
      console.warn(`[points] ${login}: error during poll: ${e.message || e}`);
      console.warn(`[points] ${login}: stack: ${e.stack || '(no stack)'}`);
    }
  }
}

/** Background poller: checks watched channels every 60s for available claims.
 *  The interval fires every 15s but each watcher is polled at most once per 60s. */
setInterval(() => {
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
