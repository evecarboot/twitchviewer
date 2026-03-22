const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
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

async function refreshUserSession(req) {
  const t = req.session.twitch;
  if (!t?.refreshToken) return null;
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
      refresh_token: t.refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  t.accessToken = data.access_token;
  if (data.refresh_token) t.refreshToken = data.refresh_token;
  t.expiresAt = Date.now() + data.expires_in * 1000;
  return t.accessToken;
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

app.use(
  session({
    name: 'twitchviewer.sid',
    store: new FileStore({
      path: path.join(__dirname, '.sessions'),
      ttl: Math.floor(SESSION_MS / 1000),
      retries: 0,
      logFn: () => {},
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

app.get('/api/status', (req, res) => {
  const configured = Boolean(
    process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET
  );
  res.json({ configured });
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

app.get('/auth/twitch', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).type('text').send('TWITCH_CLIENT_ID is not set');
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
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

app.get('/api/streams', async (req, res) => {
  const raw = req.query.login || '';
  const logins = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!logins.length) {
    return res.json({ online: [], configured: false, error: null });
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({
      online: [],
      configured: false,
      error: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env',
    });
  }

  const token = await getAppToken();
  if (!token) {
    return res.status(503).json({
      online: [],
      configured: true,
      error: 'Could not obtain Twitch app token',
    });
  }

  const chunkSize = 100;
  const online = [];
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
          configured: true,
          error: `Helix error ${helix.status}: ${text}`,
        });
      }
      const body = await helix.json();
      for (const s of body.data || []) {
        online.push(s.user_login.toLowerCase());
      }
    }
    return res.json({ online, configured: true, error: null });
  } catch (e) {
    return res.status(500).json({
      online: [],
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

function startFfmpegIfNeeded(hash, url) {
  const existing = transcodeState.get(hash);
  if (existing && existing.proc && !existing.error) return;
  if (existing && existing.error) transcodeState.delete(hash);
  const dir = path.join(root, '.hls-transcode', hash);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, 'playlist.m3u8');
  const segPattern = path.join(dir, 'seg_%03d.ts').replace(/\\/g, '/');
  const playlistArg = playlist.replace(/\\/g, '/');

  const preset = (process.env.FFMPEG_PRESET || 'veryfast').trim() || 'veryfast';
  const vfArgs = [];
  const maxH = process.env.FFMPEG_MAX_HEIGHT;
  if (maxH && /^\d+$/.test(String(maxH).trim())) {
    vfArgs.push('-vf', `scale=-2:${String(maxH).trim()}`);
  }

  const proc = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'warning',
      '-fflags',
      '+genpts',
      '-i',
      url,
      ...vfArgs,
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-tune',
      'zerolatency',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_list_size',
      '8',
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      segPattern,
      playlistArg,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
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
      '[transcode] ffmpeg not found or failed to start. Install ffmpeg and add it to PATH.',
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
  const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
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

async function createTlsOptions() {
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
  return { key: pems.private, cert: pems.cert };
}

function printStartupTips(scheme) {
  console.log(
    `OAuth redirect URLs to register in Twitch (must match scheme ${scheme}://):`
  );
  console.log(`  ${scheme}://127.0.0.1:${port}/auth/callback`);
  console.log(`  ${scheme}://localhost:${port}/auth/callback`);
  console.log(
    `Or set TWITCH_REDIRECT_URI in .env to one exact URL and add that same URL in Twitch.`
  );
  if (scheme === 'https') {
    console.log(
      `Browser certificate warning: Advanced → Continue (self-signed cert, local dev only).`
    );
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
    .createServer(tls, app)
    .listen(port, () => {
      console.log(`Twitch viewer (HTTPS): https://localhost:${port}`);
      printStartupTips('https');
    });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
