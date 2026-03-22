const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
require('dotenv').config();

const app = express();
const root = __dirname;

const SCOPES = 'user:read:email user:read:follows';

function getPort() {
  return Number(process.env.PORT) || 3000;
}

function getRedirectUri() {
  if (process.env.TWITCH_REDIRECT_URI) {
    return process.env.TWITCH_REDIRECT_URI.trim();
  }
  return `http://127.0.0.1:${getPort()}/auth/callback`;
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

app.use(
  session({
    name: 'twitchviewer.sid',
    secret:
      process.env.SESSION_SECRET ||
      'change-me-in-production-use-long-random-string',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 14 * 24 * 60 * 60 * 1000,
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

app.get('/api/me', (req, res) => {
  const t = req.session.twitch;
  if (!t?.login) {
    return res.json({ authenticated: false });
  }
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
  const redirectUri = getRedirectUri();
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
  const redirectUri = getRedirectUri();
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

app.get('/', (_req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});
app.get('/styles.css', (_req, res) => {
  res.sendFile(path.join(root, 'styles.css'));
});
app.get('/app.js', (_req, res) => {
  res.sendFile(path.join(root, 'app.js'));
});

const port = getPort();
app.listen(port, () => {
  console.log(`Twitch viewer: http://localhost:${port}`);
  console.log(`OAuth callback (add to Twitch app): ${getRedirectUri()}`);
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
});
