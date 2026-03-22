# Twitch viewer

A **local** web app for watching **multiple streams** in one grid: **Twitch**, **YouTube** embeds, and **HLS** (`.m3u8`) in the browser, with optional **server-side transcoding** via **ffmpeg** when a feed uses codecs the browser cannot play (for example broadcast **MPEG-2**). Optional **Twitch** chat, offline hiding, OAuth login, and **import follows** are supported.

Twitch and YouTube embeds require a real `http://` or `https://` origin. This project ships a small **Node.js** server you run on your PC; opening files as `file://` will not load those players (platform rules).

By default the server uses **HTTPS** with a **self-signed** certificate so OAuth redirect URLs can use `https://` (as Twitch often requires). Your browser will warn once; choose **Advanced → Continue** for local development only.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (includes `npm`)
- A [Twitch developer application](https://dev.twitch.tv/console/apps) if you use live/offline detection, login, or import follows (see [Twitch setup](#twitch-setup))
- **[ffmpeg](https://ffmpeg.org/)** on your `PATH` **only** if you use **`transcode:`** HLS URLs (see [HLS and transcoding](#hls-and-transcoding))

## Quick start

```bash
git clone <your-repository-url>
cd twitchviewer
npm install
cp .env.example .env   # on Windows: copy .env.example .env
```

Edit `.env` with your Twitch **Client ID** and **Client Secret** if you use Twitch API features (see [Twitch setup](#twitch-setup)).

```bash
npm start
```

Open [https://127.0.0.1:3000](https://127.0.0.1:3000) or [https://localhost:3000](https://localhost:3000) and accept the certificate warning the first time (self-signed, local only). Register the matching **`https://…/auth/callback`** URLs in Twitch (see below).

On Windows you can double-click **`View Twitch Viewer.bat`** in the project folder: it runs `npm install` if needed, starts the server, and opens the browser.

## Twitch setup

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and **Register Your Application**.
2. **OAuth Redirect URLs**: add the callback URL that matches how you open the app (must match **exactly**, including **https**, host, port, and path):
   - **`https://127.0.0.1:3000/auth/callback`** and/or **`https://localhost:3000/auth/callback`** (default server uses HTTPS).
   - Twitch treats `localhost` and `127.0.0.1` as different — add both if you switch between them.
3. **Client type**: **Confidential** (the server keeps the client secret).
4. After creation, copy the **Client ID**. Generate a **Client Secret** (shown once) and put both in `.env`.

The app uses:

- **App credentials** (client ID + secret) for server-to-server calls (for example live/offline checks).
- **OAuth** (optional) so you can sign in with Twitch and use **Import follows**.

## Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `TWITCH_CLIENT_ID` | Yes* | From your Twitch app (*needed for live/offline, login, follows) |
| `TWITCH_CLIENT_SECRET` | Yes* | From your Twitch app (Confidential apps) |
| `PORT` | No | Server port (default `3000`) |
| `TWITCH_REDIRECT_URI` | No | Must match a redirect URL on Twitch (default `https://127.0.0.1:PORT/auth/callback` when using HTTPS) |
| `USE_HTTP` | No | Set to `true` to serve **HTTP only** (then use `http://…` OAuth URLs in Twitch) |
| `SESSION_SECRET` | No | Random string used to sign login cookies (recommended so sessions behave predictably) |
| `FFMPEG_MAX_HEIGHT` | No | For **`transcode:`** streams only: e.g. `480` to scale video height (lowers CPU use) |
| `FFMPEG_PRESET` | No | x264 preset for transcoding (default `veryfast`; try `fast` or `faster` to reduce CPU a bit) |

Never commit `.env` or share your client secret. `.gitignore` excludes `.env`, `.sessions/` (login session files), and `.hls-transcode/` (transcoded HLS cache).

## Features

### Streams and layout

- **Twitch**: enter a channel login, or prefix with `twitch:` (e.g. `twitch:channelname`).
- **YouTube**: paste a watch, embed, Shorts, or live URL, or use `yt:` / `youtube:` plus the video ID or URL.
- **HLS**: paste an `https://…` playlist URL that looks like HLS (often contains `m3u8`, `/hls/`, or `/manifest/`), or prefix with `hls:`.
- **Transcoded HLS** (`transcode:https://…/playlist.m3u8`): the server runs **ffmpeg** to re-encode to **H.264/AAC** (needed for many broadcast **MPEG-2** `.ts` streams that Chrome/Edge cannot decode). Requires **ffmpeg** installed and on `PATH`. The app checks `/api/transcode/status` before adding.
- **Grid**: layout scales with the number of streams; **minimum cell size** is enforced (~**400×300** CSS pixels) so **Twitch** embeds can autoplay (muted); the grid **scrolls** when needed.
- **Persistence**: channel list and UI options are stored in **`localStorage`** (saved layout survives refresh and browser restart).

### Twitch-only features

- **Hide offline**: when app credentials are set, optionally hide offline channels; they reappear when the API reports them live. Poll interval is **45 seconds**; use **Refresh streams** to check immediately.
- **Twitch chat** (optional): side panel with a **channel dropdown** in the toolbar and in the **chat panel header** (Twitch channels only). Chat is not available for YouTube/HLS-only layouts unless you also add a Twitch channel.
- **Twitch login** and **Import follows**: OAuth; session is stored in an **HTTP-only cookie** with **session data on disk** (`session-file-store` under `.sessions/`) so login survives **Node process restarts** (not only browser refresh).

### Performance (when many streams are open)

- **Background tab**: embeds and chat stay loaded so audio/video can keep playing while you use another tab (the browser may still throttle background tabs).
- **Scrollable grid**: cells that scroll off-screen unload embeds (iframes blanked; HLS uses `stopLoad` / `startLoad` when visible again).
- **Lazy loading** for Twitch/YouTube iframes where supported.
- **CSS** `content-visibility` hints on cells to reduce off-screen work.
- **Transcoding**: optional **`FFMPEG_MAX_HEIGHT`** / **`FFMPEG_PRESET`** in `.env` to reduce CPU for `transcode:` feeds.

### Notes

- **Twitch embed autoplay**: Browsers only allow **muted** autoplay in third-party frames when the **player URL is assigned in the same turn as a user gesture** (e.g. clicking the **Start playback** overlay). Unlocking is **not** persisted across reloads (that used to break autoplay after refresh). Toolbar actions that `await` the network before rebuilding the grid can still leave Twitch showing a **play** button — click play in the embed or use **HLS** (`m3u8` / `transcode:`) for that stream. Twitch has also said embed **autoplay is not always honored** ([forums](https://discuss.dev.twitch.com/t/embed-video-autoplay-is-not-honored/15795)).
- **Channel points**: Twitch does not guarantee that **embedded** players earn channel points the same way as watching on **twitch.tv**. For reliable channel points, watch on Twitch directly.
- **Same host for OAuth**: use either **`localhost`** or **`127.0.0.1`** consistently; cookies are per-host.

## Input prefixes (optional)

| Prefix | Meaning |
|--------|---------|
| `twitch:` | Twitch channel login |
| `yt:` / `youtube:` | YouTube video ID or URL |
| `hls:` | HLS URL (when not already obvious from the path) |
| `transcode:` | HLS URL re-encoded on the server via ffmpeg (browser-friendly codecs) |

## HLS and transcoding

- Use the **master `.m3u8` playlist** URL, not individual `.ts` segments or unrelated `.vtt` subtitle URLs.
- **Direct HLS** in the browser uses **hls.js** (and native HLS on Safari). If playback fails with a codec error, many feeds use **MPEG-2** video in TS — **Chromium** cannot play that in the browser.
- **`transcode:https://…/stream.m3u8`**: the server runs ffmpeg and serves a **local** HLS URL under `/api/transcode/…`. Install **ffmpeg**, restart the server, then add the stream with the `transcode:` prefix.
- Tune **CPU** for transcoding with **`FFMPEG_MAX_HEIGHT`** (e.g. `480`) and **`FFMPEG_PRESET`** in `.env` (see table above).

## Project layout

| Path | Role |
|------|------|
| `server.js` | Express: static files, Twitch OAuth, Helix proxy, sessions, HLS transcode endpoints |
| `index.html`, `styles.css`, `app.js` | Front end |
| `View Twitch Viewer.bat` | Windows helper to install deps, run the server, open the browser |
| `.sessions/` | File-based login sessions (created at runtime; gitignored) |
| `.hls-transcode/` | Transcoded HLS output (gitignored) |

## Troubleshooting

- **Blank / blocked embeds**: Use `https://127.0.0.1:3000` or `https://localhost:3000`, not `file://`.
- **Browser warns about certificate / “not secure”**: Expected for the built-in **self-signed** certificate. For local use only, use **Advanced → Continue** (wording varies by browser).
- **`ERR_SSL_PROTOCOL_ERROR` when opening `http://`**: The default server listens for **HTTPS** only. Either open **`https://127.0.0.1:3000`**, or set **`USE_HTTP=true`** in `.env` and use **`http://`** everywhere (including Twitch OAuth URLs).
- **`redirect_mismatch` / “redirect_uri does not match registered URI”**:
  - In the [Twitch Developer Console](https://dev.twitch.tv/console/apps), **OAuth Redirect URLs** must match **exactly** (including `https://` vs `http://`, host, port, and `/auth/callback`).
  - Defaults: **`https://127.0.0.1:3000/auth/callback`** and **`https://localhost:3000/auth/callback`** — add the one(s) you use.
  - Optional: set **`TWITCH_REDIRECT_URI`** in `.env` to one exact URL and add **that same** URL in Twitch.
- **Live/offline not working**: Confirm `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in `.env` and restart the server.
- **Logged out every server restart**: Set **`SESSION_SECRET`** in `.env`; ensure the server can write `.sessions/` (folder is gitignored but created automatically).
- **HLS fails in Chrome / “codec” errors**: Try **`transcode:`** with ffmpeg installed, or **Safari** for some native HLS feeds, or use a feed that is already **H.264/AAC**.
- **`transcode:`** fails: Check **ffmpeg** is on `PATH` (`ffmpeg -version` in a terminal). Watch the **server console** for ffmpeg errors. Optionally set **`FFMPEG_MAX_HEIGHT`** / **`FFMPEG_PRESET`** to reduce load.

## License

This project is **not** open source. See [`LICENSE`](LICENSE) for the full terms.

In short: you may **run and use it locally on your own machine for personal, non-commercial use**. You may **not** modify the code, redistribute it, or use it commercially without permission. You must still follow [Twitch’s developer terms](https://www.twitch.tv/p/legal/developer-agreement/) and [community guidelines](https://safety.twitch.tv/s/article/Community-Guidelines) when using Twitch features, and respect YouTube and other platforms’ terms when embedding their content.
