# Twitch viewer

A small **local** web app for watching **multiple Twitch channels** in one grid, with optional chat, offline hiding, and Twitch login (including importing your followed channels).

Twitch embeds require a real `http://` or `https://` origin. This project ships a tiny **Node.js** server you run on your PC; opening the HTML file directly as `file://` will not load the player (Twitch’s rules).

By default the server uses **HTTPS** with a **self-signed** certificate so OAuth redirect URLs can use `https://` (as Twitch often requires). Your browser will warn once; choose **Advanced → Continue** for local development only.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (includes `npm`)
- A [Twitch developer application](https://dev.twitch.tv/console/apps) (see below)

## Quick start

```bash
git clone <your-repository-url>
cd twitchviewer
npm install
cp .env.example .env   # on Windows: copy .env.example .env
```

Edit `.env` with your Twitch **Client ID** and **Client Secret** (see [Twitch setup](#twitch-setup)).

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
| `TWITCH_CLIENT_ID` | Yes | From your Twitch app |
| `TWITCH_CLIENT_SECRET` | Yes | From your Twitch app (Confidential apps) |
| `PORT` | No | Server port (default `3000`) |
| `TWITCH_REDIRECT_URI` | No | Must match a redirect URL on Twitch (default `https://127.0.0.1:PORT/auth/callback` when using HTTPS) |
| `USE_HTTP` | No | Set to `true` to serve **HTTP only** (then use `http://…` OAuth URLs in Twitch) |
| `SESSION_SECRET` | No | Random string used to sign login cookies (recommended) |

Never commit `.env` or share your client secret. `.gitignore` already excludes `.env`.

## Features

- **Multi-channel grid** that uses the full window; layout scales for many streams.
- **Persistence**: channel list and UI options are saved in the browser (`localStorage`) across refresh and restarts.
- **Chat**: optional side panel for one channel’s embed chat (video embeds stay chat-free by default).
- **Hide offline**: when Twitch API credentials are configured, optionally hide offline channels and restore them when they go live again.
- **Twitch login**: “Log in with Twitch” uses OAuth; session is stored in an HTTP-only cookie.
- **Import follows**: after login, merge channels you follow on Twitch into the viewer list.

## Project layout

| Path | Role |
|------|------|
| `server.js` | Express server: static files, Twitch OAuth callback, Helix proxy, sessions |
| `index.html`, `styles.css`, `app.js` | Front end |
| `View Twitch Viewer.bat` | Windows helper to install deps, run the server, open the browser |

## Troubleshooting

- **Blank / blocked embeds**: Use `https://127.0.0.1:3000` or `https://localhost:3000` (default), not `file://`.
- **Browser warns about certificate / “not secure”**: Expected for the built-in **self-signed** certificate. For local use only, use **Advanced → Continue** (wording varies by browser).
- **`ERR_SSL_PROTOCOL_ERROR` when opening `http://`**: The default server listens for **HTTPS** only. Either open **`https://127.0.0.1:3000`**, or set **`USE_HTTP=true`** in `.env` and use **`http://`** everywhere (including Twitch OAuth URLs).
- **`redirect_mismatch` / “redirect_uri does not match registered URI”**:
  - In the [Twitch Developer Console](https://dev.twitch.tv/console/apps), **OAuth Redirect URLs** must match **exactly** (including `https://` vs `http://`, host, port, and `/auth/callback`).
  - Defaults: **`https://127.0.0.1:3000/auth/callback`** and **`https://localhost:3000/auth/callback`** — add the one(s) you use.
  - Optional: set **`TWITCH_REDIRECT_URI`** in `.env` to one exact URL and add **that same** URL in Twitch.
- **Live/offline not working**: Confirm `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in `.env` and restart the server.

## License

This project is **not** open source. See [`LICENSE`](LICENSE) for the full terms.

In short: you may **run and use it locally on your own machine for personal, non-commercial use**. You may **not** modify the code, redistribute it, or use it commercially without permission. You must still follow [Twitch’s developer terms](https://www.twitch.tv/p/legal/developer-agreement/) and [community guidelines](https://safety.twitch.tv/s/article/Community-Guidelines) when using Twitch features.
