(function () {
  const isFileProtocol =
    typeof location !== 'undefined' && location.protocol === 'file:';
  if (isFileProtocol) {
    const fp = document.getElementById('file-protocol');
    const appEl = document.getElementById('app');
    if (fp) fp.hidden = false;
    if (appEl) appEl.hidden = true;
    return;
  }

  const STORAGE_KEY = 'twitchviewer:v1';
  const POLL_MS = 45_000;
  /** Followed categories refresh faster than the general online poll so new/ended
   *  streams in a category show up without reloading the page. */
  const CATEGORY_POLL_MS = 20_000;
  const FETCH_OPTS = { credentials: 'same-origin' };

  const defaultState = () => ({
    channels: [],
    importedFollows: [],
    categoryFollows: [],
    hideOffline: false,
    autoplay: true,
    priorityTiles: false,
    prioritySelection: [],
    sortByViews: false,
    sortByViewsInvert: false,
    /** Twitch logins (lowercase) that have their per-tile chat open — each tile
     *  splits into VIDEO | CHAT when present. */
    cellChats: [],
    toolbarCollapsed: false,
  });

  let state = loadState();
  let apiConfigured = false;
  /** 'hls' = Twitch via streamlink+ffmpeg on server; 'iframe' = official embed */
  let twitchPlayback = 'iframe';
  let pollFailed = false;
  let onlineSet = new Set();
  /** @type {Map<string, number>} Twitch login (lowercase) -> current viewer count. */
  let viewerCounts = new Map();
  let pollTimer = null;
  let categoryPollTimer = null;
  /** @type {IntersectionObserver[]} */
  let cellObservers = [];
  /** Stagger Twitch iframe mounts (Helix + browser load). */
  let twitchEmbedQueue = Promise.resolve();
  /** Stagger per-tile chat iframe preloads so we don't burst Twitch's embed endpoint. */
  let chatPreloadQueue = Promise.resolve();
  /** `https://player.twitch.tv/js/embed/v1.js` load promise (Twitch.Player + setQuality). */
  let twitchEmbedScriptPromise = null;
  let twitchEmbedSeq = 0;
  /** @type {Set<string>} */
  let followModalSelection = new Set();
  /** @type {Set<string>} */
  let priorityModalSelection = new Set();
  /** Debounce for layoutGridToViewport (resize + ResizeObserver). */
  let gridLayoutTimer = null;

  const els = {
    addForm: document.getElementById('add-form'),
    channelInput: document.getElementById('channel-input'),
    hideOffline: document.getElementById('hide-offline'),
    autoplayToggle: document.getElementById('autoplay-toggle'),
    priorityTiles: document.getElementById('priority-tiles'),
    priorityEditSelection: document.getElementById('edit-priority-selection'),
    sortByViews: document.getElementById('sort-by-views'),
    sortByViewsWrap: document.getElementById('sort-by-views-wrap'),
    sortByViewsInvert: document.getElementById('sort-by-views-invert'),
    sortByViewsInvertWrap: document.getElementById('sort-by-views-invert-wrap'),
    refreshStreams: document.getElementById('refresh-streams'),
    followGame: document.getElementById('follow-game'),
    categoryList: document.getElementById('category-list'),
    toolbarToggle: document.getElementById('toolbar-toggle'),
    toolbar: document.getElementById('toolbar'),
    peekTab: document.getElementById('peek-tab'),
    app: document.getElementById('app'),
    main: document.getElementById('main'),
    toolbarMeta: document.getElementById('toolbar-meta'),
    channelList: document.getElementById('channel-list'),
    grid: document.getElementById('grid'),
    gridSplit: document.getElementById('grid-split'),
    gridPriority: document.getElementById('grid-priority'),
    gridArea: document.getElementById('grid-area'),
    authLogin: document.getElementById('auth-login'),
    authUserWrap: document.getElementById('auth-user-wrap'),
    authAvatar: document.getElementById('auth-avatar'),
    authUserLabel: document.getElementById('auth-user-label'),
    importFollows: document.getElementById('import-follows'),
    editFollowSelection: document.getElementById('edit-follow-selection'),
    followModal: document.getElementById('follow-modal'),
    followModalBackdrop: document.getElementById('follow-modal-backdrop'),
    followFilter: document.getElementById('follow-filter'),
    followList: document.getElementById('follow-list'),
    followCount: document.getElementById('follow-count'),
    followModalSave: document.getElementById('follow-modal-save'),
    followModalCancel: document.getElementById('follow-modal-cancel'),
    followSelectAll: document.getElementById('follow-select-all'),
    followSelectNone: document.getElementById('follow-select-none'),
    followModalRefresh: document.getElementById('follow-modal-refresh'),
    // Priority modal
    priorityModal: document.getElementById('priority-modal'),
    priorityModalBackdrop: document.getElementById('priority-modal-backdrop'),
    priorityFilter: document.getElementById('priority-filter'),
    priorityList: document.getElementById('priority-list'),
    priorityCount: document.getElementById('priority-count'),
    prioritySelectAll: document.getElementById('priority-select-all'),
    prioritySelectNone: document.getElementById('priority-select-none'),
    priorityModalSave: document.getElementById('priority-modal-save'),
    priorityModalCancel: document.getElementById('priority-modal-cancel'),
    // Channel points
    linkPoints: document.getElementById('link-points'),
    pointsModal: document.getElementById('points-modal'),
    pointsModalBackdrop: document.getElementById('points-modal-backdrop'),
    pointsModalCancel: document.getElementById('points-modal-cancel'),
    pointsUnlink: document.getElementById('points-unlink'),
    pointsDeviceCode: document.getElementById('points-device-code'),
    pointsDeviceUrl: document.getElementById('points-device-url'),
    pointsCodeDisplay: document.getElementById('points-code-display'),
    pointsPollingStatus: document.getElementById('points-polling-status'),
    pointsLinked: document.getElementById('points-linked'),
    pointsLinkedLogin: document.getElementById('points-linked-login'),
    pointsClaimsSummary: document.getElementById('points-claims-summary'),
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const merged = {
        ...defaultState(),
        ...parsed,
        channels: migrateChannels(parsed.channels),
        importedFollows: Array.isArray(parsed.importedFollows)
          ? parsed.importedFollows
          : [],
        categoryFollows: migrateCategoryFollows(parsed.categoryFollows),
        cellChats: Array.isArray(parsed.cellChats)
          ? parsed.cellChats.map((s) => normalizeLogin(s)).filter(Boolean)
          : [],
      };
      delete merged.autoplayStreams;
      return merged;
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function migrateChannels(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const c of arr) {
      const n = normalizeChannelEntry(c);
      if (n) out.push(n);
    }
    return out;
  }

  /** `limit: null` means "follow every live stream in this category" (server still
   *  applies a hard safety cap so a huge category can't flood the grid). */
  function normalizeCategoryFollow(c) {
    if (!c || typeof c !== 'object') return null;
    const id = typeof c.id === 'string' ? c.id : '';
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!id || !name) return null;
    if (c.limit == null) return { id, name, limit: null };
    let limit = Number(c.limit);
    if (!Number.isFinite(limit) || limit < 1) return { id, name, limit: null };
    limit = Math.min(Math.max(Math.round(limit), 1), 100);
    return { id, name, limit };
  }

  function migrateCategoryFollows(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const c of arr) {
      const n = normalizeCategoryFollow(c);
      if (n) out.push(n);
    }
    return out;
  }

  function normalizeChannelEntry(c) {
    if (typeof c === 'string') {
      const login = normalizeLogin(c);
      return login ? { type: 'twitch', login } : null;
    }
    if (!c || typeof c !== 'object') return null;
    if (c.type === 'twitch' && c.login) {
      const login = normalizeLogin(c.login);
      if (!login) return null;
      const out = { type: 'twitch', login };
      if (typeof c.fromCategory === 'string' && c.fromCategory) {
        out.fromCategory = c.fromCategory;
      }
      return out;
    }
    if (c.type === 'youtube' && c.id && typeof c.id === 'string') {
      const id = String(c.id);
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return { type: 'youtube', id };
      return null;
    }
    if (c.type === 'hls' && c.url && typeof c.url === 'string') {
      const url = String(c.url).trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const out = { type: 'hls', url };
      if (c.transcode) out.transcode = true;
      if (typeof c.transcodeHash === 'string' && c.transcodeHash) {
        out.transcodeHash = c.transcodeHash;
      }
      return out;
    }
    return null;
  }

  function getChannelType(ch) {
    if (typeof ch === 'string') return 'twitch';
    return ch && ch.type ? ch.type : 'twitch';
  }

  function getTwitchLogin(ch) {
    if (typeof ch === 'string') return normalizeLogin(ch);
    if (ch && ch.type === 'twitch' && ch.login) return normalizeLogin(ch.login);
    return '';
  }

  function channelKey(ch) {
    const t = getChannelType(ch);
    if (t === 'twitch') return `t:${getTwitchLogin(ch)}`;
    if (t === 'youtube') return `y:${ch.id}`;
    if (t === 'hls') return ch.transcode ? `ht:${ch.url}` : `h:${ch.url}`;
    return '';
  }

  function formatChannelLabel(ch) {
    const t = getChannelType(ch);
    if (t === 'twitch') return getTwitchLogin(ch);
    if (t === 'youtube') return `YT: ${ch.id}`;
    if (t === 'hls') {
      const short = hlsShortLabel(ch.url);
      return ch.transcode ? `HLS (ffmpeg): ${short}` : `HLS: ${short}`;
    }
    return '?';
  }

  function hlsShortLabel(url) {
    try {
      const u = new URL(url);
      const tail = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      return tail.length > 24 ? `${tail.slice(0, 22)}…` : tail;
    } catch {
      return url.length > 28 ? `${url.slice(0, 26)}…` : url;
    }
  }

  function isLikelyHlsUrl(s) {
    return /\.m3u8(\?|$)/i.test(s) || /\/hls\//i.test(s) || /\/manifest\//i.test(s);
  }

  function extractYoutubeId(input) {
    const s = String(input).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') {
        const id = u.pathname.slice(1).split('/')[0];
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      }
      if (
        host === 'youtube.com' ||
        host === 'youtube-nocookie.com' ||
        host === 'm.youtube.com' ||
        host === 'music.youtube.com'
      ) {
        const v = u.searchParams.get('v');
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
        const embed = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embed) return embed[1];
        const live = u.pathname.match(/\/live\/([a-zA-Z0-9_-]{11})/);
        if (live) return live[1];
        const sh = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (sh) return sh[1];
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function parseAddInput(raw) {
    const s = String(raw).trim();
    if (!s) return null;

    if (/^twitch:/i.test(s)) {
      const login = normalizeLogin(s.replace(/^twitch:/i, ''));
      return login ? { type: 'twitch', login } : null;
    }
    if (/^(?:yt|youtube):/i.test(s)) {
      const rest = s.replace(/^(?:yt|youtube):/i, '').trim();
      const url = /^https?:\/\//i.test(rest)
        ? rest
        : `https://youtu.be/${rest}`;
      const yt = extractYoutubeId(url);
      return yt ? { type: 'youtube', id: yt } : null;
    }
    if (/^transcode:/i.test(s)) {
      const rest = s.replace(/^transcode:/i, '').trim();
      if (/^https?:\/\//i.test(rest)) {
        return { type: 'hls', url: rest, transcode: true };
      }
      return null;
    }
    if (/^hls:/i.test(s)) {
      const rest = s.replace(/^hls:/i, '').trim();
      if (/^https?:\/\//i.test(rest)) return { type: 'hls', url: rest };
      return null;
    }

    if (/^https?:\/\//i.test(s)) {
      const yt = extractYoutubeId(s);
      if (yt) return { type: 'youtube', id: yt };
      if (isLikelyHlsUrl(s)) return { type: 'hls', url: s };
      return null;
    }

    const login = normalizeLogin(s);
    return login ? { type: 'twitch', login } : null;
  }

  function twitchChannelsForChat() {
    return state.channels
      .filter((c) => getChannelType(c) === 'twitch')
      .map((c) => getTwitchLogin(c));
  }

  function youtubeEmbedSrc(id) {
    const params = new URLSearchParams({
      autoplay: state.autoplay ? '1' : '0',
      mute: '1',
      playsinline: '1',
    });
    return `https://www.youtube.com/embed/${encodeURIComponent(
      id
    )}?${params.toString()}`;
  }

  function normalizeLogin(s) {
    return String(s || '')
      .trim()
      .replace(/^#/, '')
      .toLowerCase()
      .replace(/\s+/g, '');
  }

  /**
   * Twitch requires every parent hostname the page may be served from (see multitwitch.tv:
   * parent=…&parent=www.…). https://dev.twitch.tv/docs/embed/video-and-clips/
   */
  function appendParentDomains(params) {
    const h = window.location.hostname;
    params.append('parent', h);
    if (h === '127.0.0.1') params.append('parent', 'localhost');
    if (h === 'localhost') params.append('parent', '127.0.0.1');
    if (h.startsWith('www.')) {
      const bare = h.slice(4);
      if (bare) params.append('parent', bare);
    } else if (
      h.length > 0 &&
      h !== 'localhost' &&
      h !== '127.0.0.1' &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(h)
    ) {
      params.append('parent', `www.${h}`);
    }
  }

  function embedParents() {
    const qs = new URLSearchParams();
    appendParentDomains(qs);
    return qs;
  }

  /** player.twitch.tv `parent` query params — real hostnames (see embed docs). */
  function parentDomainsForTwitch() {
    const h = window.location.hostname;
    /** @type {string[]} */
    const parents = [];
    const add = (p) => {
      if (p && !parents.includes(p)) parents.push(p);
    };
    add(h);
    if (h === '127.0.0.1') add('localhost');
    if (h === 'localhost') add('127.0.0.1');
    if (h.startsWith('www.')) {
      add(h.slice(4));
    } else if (
      h.length > 0 &&
      h !== 'localhost' &&
      h !== '127.0.0.1' &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(h)
    ) {
      add(`www.${h}`);
    }
    return parents;
  }

  /**
   * Twitch docs recommend ~400x300 minimum for embeds, but that can force very sparse
   * layouts on ultrawide/fullscreen. Use a softer minimum so 5+ streams can still tile.
   */
  const GRID_MIN_CELL_W = 320;
  const GRID_MIN_CELL_H = 180;
  // For non-iframe modes (HLS <video> path, YouTube embeds, etc.) we can allow
  // smaller cells than the Twitch autoplay-sensitive iframe minimum.
  // This prevents "single-line strip" layouts on shorter viewports.
  const GRID_MIN_CELL_W_SOFT = 240;
  const GRID_MIN_CELL_H_SOFT = 135;

  /** Space embeds apart: Helix limits + fewer simultaneous WebGL contexts in the browser. */
  function queueTwitchMount(run) {
    twitchEmbedQueue = twitchEmbedQueue.then(
      () =>
        new Promise((resolve) => {
          window.setTimeout(() => {
            try {
              run();
            } catch {
              /* ignore */
            }
            window.setTimeout(resolve, 900);
          }, 0);
        })
    );
  }

  /**
   * Twitch rejects muted autoplay unless the embed meets size + “style visibility” +
   * viewport visibility. Wait until the cell is laid out and on-screen before Player().
   * TWITCH_VIS_EPS: overlap/size checks use 1px slack for subpixel layout (e.g. 399.7px).
   */
  const TWITCH_VIS_EPS = 1;

  function twitchCellReadyForEmbed(cell) {
    if (!cell || !cell.isConnected) return false;
    if (document.visibilityState !== 'visible' || document.hidden) return false;
    if (cell.clientWidth < GRID_MIN_CELL_W || cell.clientHeight < GRID_MIN_CELL_H)
      return false;
    const r = cell.getBoundingClientRect();
    if (r.width + TWITCH_VIS_EPS < GRID_MIN_CELL_W || r.height + TWITCH_VIS_EPS < GRID_MIN_CELL_H)
      return false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overlapW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const overlapH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const needW = Math.min(GRID_MIN_CELL_W, vw);
    const needH = Math.min(GRID_MIN_CELL_H, vh);
    if (
      overlapW + TWITCH_VIS_EPS < needW ||
      overlapH + TWITCH_VIS_EPS < needH
    )
      return false;
    let el = cell;
    while (el && el.nodeType === 1) {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) < 0.01) return false;
      el = el.parentElement;
    }
    return true;
  }

  function whenTwitchCellPaintable(cell, onReady) {
    let done = false;
    let ro = null;
    let io = null;
    let timeoutId = 0;

    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVis);
      if (ro) {
        try {
          ro.disconnect();
        } catch {
          /* ignore */
        }
        ro = null;
      }
      if (io) {
        try {
          io.disconnect();
        } catch {
          /* ignore */
        }
        io = null;
      }
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = 0;
      }
    };

    const fire = () => {
      if (done) return;
      done = true;
      cleanup();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.setTimeout(onReady, 280);
        });
      });
    };

    const tryNow = () => {
      if (done) return;
      if (twitchCellReadyForEmbed(cell)) fire();
    };

    function onVis() {
      if (document.visibilityState === 'visible') tryNow();
    }

    if (twitchCellReadyForEmbed(cell)) {
      fire();
      return;
    }

    document.addEventListener('visibilitychange', onVis);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => tryNow());
      ro.observe(cell);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(() => tryNow(), {
        root: null,
        rootMargin: '0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      });
      io.observe(cell);
    }
    timeoutId = window.setTimeout(() => {
      if (!done) fire();
    }, 9000);
  }

  function showTwitchEmbedError(wrap, login, msg) {
    try {
      wrap.innerHTML = '';
    } catch {
      /* ignore */
    }
    const err = document.createElement('div');
    err.className = 'cell-hls-error';
    err.style.pointerEvents = 'auto';
    err.textContent = msg || `Could not load Twitch (${login}).`;
    wrap.appendChild(err);
  }

  /**
   * Interactive embed (`Twitch.Player`) so we can call setQuality (see Twitch docs).
   * Falls back to a plain iframe if the script fails to load.
   * https://dev.twitch.tv/docs/embed/video-and-clips/
   */
  function ensureTwitchEmbedScript() {
    if (typeof Twitch !== 'undefined' && Twitch.Player) return Promise.resolve();
    if (twitchEmbedScriptPromise) return twitchEmbedScriptPromise;
    twitchEmbedScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://player.twitch.tv/js/embed/v1.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Twitch embed script failed to load'));
      document.head.appendChild(s);
    });
    return twitchEmbedScriptPromise;
  }

  function twitchQualityLabelsFromPlayer(player) {
    try {
      if (!player || typeof player.getQualities !== 'function') return [];
      const raw = player.getQualities();
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item.name === 'string') out.push(item.name);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** When Priority tiles is off, prefer ~480p to reduce bandwidth across many streams. */
  function pickTwitchQualityPrefer480(labels) {
    if (!labels.length) return null;
    const lower = labels.map((l) => l.toLowerCase());
    const tests = [
      (i) => lower[i] === '480p60' || lower[i] === '480p30' || lower[i] === '480p',
      (i) => /^480p\d*$/.test(lower[i]),
      (i) => lower[i].includes('480'),
      (i) => /^416p/.test(lower[i]),
      (i) => /^360p\d*$/.test(lower[i]) || lower[i].includes('360'),
      (i) => /^270p/.test(lower[i]),
      (i) => /^160p/.test(lower[i]),
    ];
    for (const pred of tests) {
      for (let i = 0; i < labels.length; i++) {
        if (pred(i)) return labels[i];
      }
    }
    const nonSource = labels.filter((l) => !/chunked|^source$/i.test(String(l)));
    if (nonSource.length) return nonSource[nonSource.length - 1];
    return labels[labels.length - 1];
  }

  function pickTwitchQualityAuto(labels) {
    const lower = labels.map((l) => l.toLowerCase());
    const idx = lower.findIndex((l) => l === 'auto');
    return idx >= 0 ? labels[idx] : null;
  }

  function desiredTwitchQualityLabel(labels) {
    if (!labels.length) return null;
    if (state.priorityTiles) return pickTwitchQualityAuto(labels);
    return pickTwitchQualityPrefer480(labels);
  }

  /**
   * Apply preferred quality once per player session. Re-applying setQuality on every
   * Twitch.Player.PLAYING event restarts the stream and looks like rapid play/pause.
   * @param {boolean} force — reset and re-apply (e.g. Priority tiles toggle).
   */
  function applyTwitchQualityPreference(player, force) {
    if (!player || typeof player.setQuality !== 'function') return;
    if (force) player._twitchQualityApplied = false;
    else if (player._twitchQualityApplied) return;

    const labels = twitchQualityLabelsFromPlayer(player);
    if (!labels.length) return;
    const desired = desiredTwitchQualityLabel(labels);
    if (!desired) {
      player._twitchQualityApplied = true;
      return;
    }
    try {
      if (typeof player.getQuality === 'function') {
        const cur = player.getQuality();
        if (
          cur &&
          String(cur).toLowerCase() === String(desired).toLowerCase()
        ) {
          player._twitchQualityApplied = true;
          return;
        }
      }
      player.setQuality(desired);
      player._twitchQualityApplied = true;
    } catch {
      /* ignore */
    }
  }

  function scheduleTwitchQualityRetries(player, cell) {
    [120, 700, 2000, 5000].forEach((ms) => {
      window.setTimeout(() => {
        if (!cell.isConnected) return;
        if (player._twitchQualityApplied) return;
        applyTwitchQualityPreference(player, false);
      }, ms);
    });
  }

  /**
   * A freshly mounted Twitch.Player is constructed with `muted`/`autoplay: true`, but the
   * very first `play()` call right after READY can silently lose a race with Twitch’s own
   * player init (the postMessage handshake to the embed iframe hasn’t settled yet), leaving
   * the tile sitting on its paused/"play button" thumbnail until someone clicks it. Retry a
   * few times — re-calling play()/setMuted() on an already-playing player is a harmless no-op —
   * and stop once PLAYING actually fires.
   */
  function scheduleTwitchPlayRetries(player, cell) {
    [150, 500, 1200, 2500, 5000].forEach((ms) => {
      window.setTimeout(() => {
        if (!cell.isConnected || player._twitchPlaybackStarted) return;
        try {
          if (typeof player.setMuted === 'function') player.setMuted(true);
          if (typeof player.play === 'function') player.play();
        } catch {
          /* ignore */
        }
      }, ms);
    });
  }

  function syncTwitchInteractiveQualities() {
    if (twitchPlayback !== 'iframe') return;
    const roots = [els.grid, els.gridPriority].filter(Boolean);
    for (const root of roots) {
      for (const cell of root.querySelectorAll('.cell')) {
        const p = cell._twitchPlayer;
        if (!p || typeof p.getQualities !== 'function') continue;
        applyTwitchQualityPreference(p, true);
      }
    }
  }

  /* --- Twitch pass-through proxy: pick streamlink quality per tile pixel size --- */
  // Twitch's HLS is already H.264/AAC, so the server proxies it unchanged (no ffmpeg).
  // To keep 15+ simultaneous tiles from melting the browser decoder, small tiles fetch a
  // lower variant (360p/480p) and only large tiles fetch 720p60. Thresholds are in CSS px².
  // Tuned for weaker CPUs (e.g. i5-6400): a 2x2 grid on 1080p gets 360p30 per tile, not 480p30.
  const TWITCH_PROXY_TIER_360 = 550000; // ~960x570 — covers typical 2x2/3x2 grid tiles
  const TWITCH_PROXY_TIER_480 = 1200000; // ~1280x940 — big tiles / 1x2 layouts
  // Above 480 tier → 720p60 (or env default if TWITCH_STREAMLINK_QUALITY is set higher).

  function twitchQualityForCell(w, h) {
    const px = Math.max(0, w | 0) * Math.max(0, h | 0);
    if (px < TWITCH_PROXY_TIER_360) return '360p30';
    if (px < TWITCH_PROXY_TIER_480) return '480p30';
    return '720p60';
  }

  function twitchProxyPlaybackUrl(login, quality) {
    const q = encodeURIComponent(quality || '720p60');
    return `${location.origin}/api/twitch-live/${encodeURIComponent(login)}/playlist.m3u8?q=${q}`;
  }

  /** Re-evaluate quality for already-mounted proxy cells after a layout change.
   *  Only reloads the HLS source when the tile crossed a quality tier (avoids thrash). */
  function refreshTwitchProxyQualities() {
    if (twitchPlayback !== 'proxy') return;
    const roots = [els.grid, els.gridPriority].filter(Boolean);
    for (const root of roots) {
      for (const cell of root.querySelectorAll('.cell')) {
        const video = cell.querySelector('video.cell-video');
        if (!video || !video._hls) continue;
        const want = twitchQualityForCell(cell.clientWidth, cell.clientHeight);
        if (video._twitchQuality === want) continue;
        const login = video._twitchLogin;
        if (!login) continue;
        video._twitchQuality = want;
        try {
          video._hls.loadSource(twitchProxyPlaybackUrl(login, want));
        } catch {
          /* ignore */
        }
      }
    }
  }

  function applyTwitchIframePixelSize(wrap, iframe) {
    const r = wrap.getBoundingClientRect();
    const w = Math.max(GRID_MIN_CELL_W, Math.round(r.width));
    const h = Math.max(GRID_MIN_CELL_H, Math.round(r.height));
    /* Skip redundant attribute writes. CSS already stretches the iframe to fill
       its cell (width/height: 100%) — these attributes only feed Twitch's own
       internal sizing logic. Reordering tiles without changing the grid's
       cols/rows (e.g. sort-by-viewers reshuffling, drag reorder) still fires
       this ResizeObserver for every surviving cell even though nothing actually
       changed size; re-writing identical width/height attributes on Twitch's
       iframe can make its player show the paused/play-button overlay for no
       reason. Only touch the attributes when the size genuinely changed. */
    if (
      iframe.getAttribute('width') === String(w) &&
      iframe.getAttribute('height') === String(h)
    ) {
      return;
    }
    iframe.setAttribute('width', String(w));
    iframe.setAttribute('height', String(h));
  }

  function wireTwitchIframeResize(wrap, iframe, cell) {
    if (cell._twitchIframeResizeObserver) {
      try {
        cell._twitchIframeResizeObserver.disconnect();
      } catch {
        /* ignore */
      }
      cell._twitchIframeResizeObserver = null;
    }
    applyTwitchIframePixelSize(wrap, iframe);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected || !iframe.isConnected) return;
      applyTwitchIframePixelSize(wrap, iframe);
    });
    ro.observe(wrap);
    cell._twitchIframeResizeObserver = ro;
  }

  /** Debug toggle: `localStorage.setItem('twitchviewer:forcePlainIframe','1')` then reload —
   *  skips the Twitch.Player JS SDK entirely to test whether the "style visibility" autoplay
   *  rejection comes from the SDK wrapper or from player.twitch.tv itself. */
  function forcePlainTwitchIframe() {
    try {
      return localStorage.getItem('twitchviewer:forcePlainIframe') === '1';
    } catch {
      return false;
    }
  }

  /** Plain iframe fallback if `embed/v1.js` does not load or Twitch.Player fails. */
  function createTwitchIframeEmbedFallback(cell, login, wrap) {
    if (!cell.isConnected || !wrap.isConnected) return;

    try {
      wrap.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.dataset.twitchEmbed = '1';
      iframe.title = `Twitch: ${login}`;
      /* `allow` includes fullscreen — avoid duplicate allowfullscreen (Chrome warns). */
      iframe.allow =
        'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share';
      /* Optional iframe src params (muted, autoplay). https://dev.twitch.tv/docs/embed/video-and-clips/ */
      const params = new URLSearchParams();
      params.set('channel', login);
      params.set('muted', 'true');
      params.set('autoplay', state.autoplay ? 'true' : 'false');
      for (const p of parentDomainsForTwitch()) {
        params.append('parent', p);
      }
      iframe.src = `https://player.twitch.tv/?${params.toString()}`;
      iframe.loading = 'eager';
      wrap.appendChild(iframe);
      wireTwitchIframeResize(wrap, iframe, cell);
      cell._twitchPlayer = iframe;
    } catch {
      showTwitchEmbedError(wrap, login, `Twitch embed error (${login}).`);
    }
  }

  function createTwitchInteractivePlayerEmbed(cell, login, wrap) {
    if (!cell.isConnected || !wrap.isConnected) return;

    const hostId = `twitch-js-${login}-${++twitchEmbedSeq}`;
    try {
      wrap.innerHTML = '';
      const host = document.createElement('div');
      host.id = hostId;
      host.className = 'twitch-embed-js-host';
      host.dataset.twitchEmbed = '1';
      wrap.appendChild(host);
    } catch {
      showTwitchEmbedError(wrap, login, `Twitch embed error (${login}).`);
      return;
    }

    ensureTwitchEmbedScript()
      .then(() => {
        if (!cell.isConnected || !wrap.isConnected) return;
        if (typeof Twitch === 'undefined' || !Twitch.Player) {
          createTwitchIframeEmbedFallback(cell, login, wrap);
          return;
        }
        const r = wrap.getBoundingClientRect();
        const w = Math.max(GRID_MIN_CELL_W, Math.round(r.width));
        const h = Math.max(GRID_MIN_CELL_H, Math.round(r.height));
        let player;
        try {
          /* Optional embed params (muted, autoplay). https://dev.twitch.tv/docs/embed/video-and-clips/ */
          player = new Twitch.Player(hostId, {
            width: w,
            height: h,
            channel: login,
            parent: parentDomainsForTwitch(),
            muted: true,
            autoplay: state.autoplay,
            // controls: false, // tried as a workaround for the "style visibility"
            // autoplay rejection (twitchdev/issues#1127) — did not fix it, reverted.
          });
        } catch {
          createTwitchIframeEmbedFallback(cell, login, wrap);
          return;
        }
        cell._twitchPlayer = player;

        const wireInnerIframeOnce = () => {
          const iframe = wrap.querySelector('iframe');
          if (!iframe) return;
          /* Twitch.Player's own iframe doesn't always set `allow="autoplay"` — without it,
             some Chromium builds (Edge included) treat autoplay as a delegated permission
             that's missing on this cross-origin frame and silently block even muted play(),
             leaving the tile on its paused thumbnail until manually clicked. */
          const wantedAllow =
            'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share';
          if (iframe.getAttribute('allow') !== wantedAllow) {
            iframe.setAttribute('allow', wantedAllow);
          }
          wireTwitchIframeResize(wrap, iframe, cell);
        };

        player.addEventListener(Twitch.Player.READY, () => {
          wireInnerIframeOnce();
          if (state.autoplay) {
            try {
              if (typeof player.setMuted === 'function') player.setMuted(true);
              if (typeof player.play === 'function') player.play();
            } catch {
              /* ignore */
            }
            scheduleTwitchPlayRetries(player, cell);
          }
          applyTwitchQualityPreference(player, true);
          scheduleTwitchQualityRetries(player, cell);
        });
        /* Mark actual playback start so the play-retry loop above stops nudging it — this
           is just a flag read, not a re-trigger, so it's fine to hook PLAYING for this. */
        player.addEventListener(Twitch.Player.PLAYING, () => {
          player._twitchPlaybackStarted = true;
        });
        /* When a channel drops offline the embed shows its own "offline" screen; when it
           comes back the Twitch player does NOT resume playback on its own (autoplay only
           applies on initial load), so without this the tile sits on a paused thumbnail
           until someone clicks the embed's play button. Re-trigger muted play on ONLINE. */
        player.addEventListener(Twitch.Player.ONLINE, () => {
          if (!state.autoplay) return;
          /* Reset so scheduleTwitchPlayRetries actually retries below — this flag was
             already set true by the PLAYING event from the stream's previous online
             session, so without resetting it the retry loop bails after a single
             immediate play() call, which is exactly the race that leaves a tile
             stuck on its paused thumbnail when a stream resumes. */
          player._twitchPlaybackStarted = false;
          try {
            if (typeof player.setMuted === 'function') player.setMuted(true);
            if (typeof player.play === 'function') player.play();
          } catch {
            /* ignore */
          }
          scheduleTwitchPlayRetries(player, cell);
        });
        /* Never hook PLAYING for setQuality or resize — PLAYING fires often during live
           playback; repeating setQuality or re-wiring resize causes visible play/stutter. */
        window.setTimeout(wireInnerIframeOnce, 400);
      })
      .catch(() => {
        createTwitchIframeEmbedFallback(cell, login, wrap);
      });
  }

  function attachTwitchEmbedCell(cell, login) {
    const wrap = document.createElement('div');
    wrap.className = 'twitch-embed-host';
    cell.appendChild(wrap);

    whenTwitchCellPaintable(cell, () => {
      queueTwitchMount(() => {
        if (!cell.isConnected || !wrap.isConnected) return;
        /* Grids can scroll horizontally; a cell may be barely off-screen. Nudge into view
           before mount so Twitch’s viewport-visibility check sees ≥400×300 (same as public multiviews that keep tiles in view). */
        if (!twitchCellReadyForEmbed(cell)) {
          cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.setTimeout(() => {
              if (!cell.isConnected || !wrap.isConnected) return;
              if (forcePlainTwitchIframe()) {
                createTwitchIframeEmbedFallback(cell, login, wrap);
              } else {
                createTwitchInteractivePlayerEmbed(cell, login, wrap);
              }
            }, 60);
          });
        });
      });
    });
  }

  function chatSrc(login) {
    const params = embedParents();
    return `https://www.twitch.tv/embed/${encodeURIComponent(
      login
    )}/chat?${params.toString()}&darkpopout`;
  }

  function gridViewportSize() {
    /**
     * Use the actual grid container (#grid-area) as the source of truth.
     * #main can be temporarily wrong during flex/resize transitions (like entering
     * fullscreen), which makes the layout solver pick bad cols×rows.
     */
    const primary = els.gridArea || els.main || els.grid;
    if (primary) {
      const r = primary.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        return { w: Math.max(400, r.width), h: Math.max(300, r.height) };
      }
    }
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const th =
      els.toolbar && !els.toolbar.classList.contains('collapsed')
        ? els.toolbar.getBoundingClientRect().height
        : 0;
    return {
      w: Math.max(400, iw - 8),
      h: Math.max(300, ih - th - 8),
    };
  }

  function currentGridMinimums(visible) {
    // Historically we dropped mins to {1,1} for non-iframe modes to enable denser
    // tiling. That can make non-priority tiles look like a compressed strip.
    // Use a soft minimum so normal tiles stay reasonably sized, while Twitch
    // iframe mode still keeps its stricter autoplay threshold.
    const hasTwitchIframe =
      twitchPlayback === 'iframe' &&
      visible.some((ch) => getChannelType(ch) === 'twitch');

    return hasTwitchIframe
      ? { minW: GRID_MIN_CELL_W, minH: GRID_MIN_CELL_H }
      : { minW: GRID_MIN_CELL_W_SOFT, minH: GRID_MIN_CELL_H_SOFT };
  }

  /**
   * Count-first balanced grid (stable across 1080p/4K/ultrawide window sizes).
   * We choose a near-square cols×rows, then only use viewport as a light tie-break.
   */
  function gridDimensions(count, vp, mins) {
    if (count <= 0) return { cols: 1, rows: 1 };
    if (count === 1) return { cols: 1, rows: 1 };
    const { w, h } = vp;
    const { minW, minH } = mins;
    let bestCols = Math.ceil(Math.sqrt(count));
    let bestRows = Math.ceil(count / bestCols);
    let bestWaste = bestCols * bestRows - count;
    let bestImbalance = Math.abs(bestCols - bestRows);
    let bestTieScore = -Infinity;
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const waste = cols * rows - count;
      const cw = w / cols;
      const ch = h / rows;
      if (cw < minW || ch < minH) continue;
      const imbalance = Math.abs(cols - rows);
      const tieScore = Math.min(cw, ch);
      if (
        waste < bestWaste ||
        (waste === bestWaste && imbalance < bestImbalance) ||
        (waste === bestWaste && imbalance === bestImbalance && tieScore > bestTieScore)
      ) {
        bestCols = cols;
        bestRows = rows;
        bestWaste = waste;
        bestImbalance = imbalance;
        bestTieScore = tieScore;
      }
    }
    if (
      w / bestCols < minW ||
      h / bestRows < minH
    ) {
      let cols = Math.max(1, Math.min(count, Math.floor(w / Math.max(1, minW))));
      if (cols < 1) cols = 1;
      const rows = Math.ceil(count / cols);
      return { cols, rows };
    }
    return { cols: bestCols, rows: bestRows };
  }

  /**
   * Non-priority layout: prefer layouts that keep tiles looking "big" for typical
   * Twitch/YouTube aspect (16:9), even if that means some grid waste (empty cells).
   *
   * This avoids the common "N columns x 1 row strip" that happens when we only
   * minimize waste/imbalance.
   */
  function gridDimensionsByStreamFit(count, vp, mins) {
    if (count <= 0) return { cols: 1, rows: 1 };
    if (count === 1) return { cols: 1, rows: 1 };

    const { w, h } = vp;
    const { minW, minH } = mins;
    const AR_W = 16;
    const AR_H = 9;

    let best = { cols: 1, rows: 1, score: -Infinity, waste: Infinity, imbalance: Infinity };

    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const cw = w / cols;
      const ch = h / rows;
      if (cw < minW || ch < minH) continue;

      // Contain-fit into a 16:9 tile.
      // displayW is limited by either the tile width or the height-constrained width.
      const displayW = Math.min(cw, (ch * AR_W) / AR_H);
      const displayH = Math.min(ch, (cw * AR_H) / AR_W);
      const score = displayW * displayH;

      const waste = cols * rows - count;
      const imbalance = Math.abs(cols - rows);

      if (
        score > best.score ||
        (score === best.score && waste < best.waste) ||
        (score === best.score && waste === best.waste && imbalance < best.imbalance)
      ) {
        best = { cols, rows, score, waste, imbalance };
      }
    }

    // Fallback to old logic if mins were too strict for this viewport.
    if (!Number.isFinite(best.score)) {
      return gridDimensions(count, vp, mins);
    }
    return { cols: best.cols, rows: best.rows };
  }

  /** Update grid columns/rows from viewport without rebuilding cells (keeps Twitch embeds alive). */
  function layoutGridToViewport() {
    if (!els.grid) return;
    const layout = computeGridLayoutVars();
    if (layout.split) {
      if (els.gridSplit) els.gridSplit.classList.toggle('priority-only', layout.rest.channels.length === 0);
      if (els.gridPriority) {
        els.gridPriority.classList.toggle(
          'no-dense',
          (layout.bigKeys || []).length > 0
        );
        els.gridPriority.style.setProperty(
          '--cell-min-w',
          `${Math.max(1, layout.mins.minW)}px`
        );
        els.gridPriority.style.setProperty(
          '--cell-min-h',
          `${Math.max(1, layout.mins.minH)}px`
        );
        els.gridPriority.style.setProperty(
          '--cols',
          String(Math.max(1, layout.priority.cols))
        );
        els.gridPriority.style.setProperty(
          '--rows',
          String(Math.max(1, layout.priority.rows))
        );
        els.gridPriority.classList.toggle(
          'one-col',
          layout.priority.channels.length === 1
        );
        applyPriorityGridSpans(layout.priority.spanW, layout.priority.spanH);
      }
      els.grid.classList.toggle('no-dense', false);
      els.grid.style.setProperty(
        '--cell-min-w',
        `${Math.max(1, layout.mins.minW)}px`
      );
      els.grid.style.setProperty(
        '--cell-min-h',
        `${Math.max(1, layout.mins.minH)}px`
      );
      els.grid.style.setProperty('--cols', String(Math.max(1, layout.rest.cols)));
      els.grid.style.setProperty('--rows', String(Math.max(1, layout.rest.rows)));
      els.grid.classList.toggle('one-col', layout.rest.channels.length === 1);
      clearRestGridSpans();
      scheduleTwitchProxyRefresh();
      return;
    }

    if (els.gridSplit) els.gridSplit.classList.remove('priority-only');
    if (els.gridPriority) {
      els.gridPriority.hidden = true;
    }
    els.grid.classList.remove('grid-rest', 'grid-rest-hidden');
    els.grid.classList.add('grid-full');
    els.grid.hidden = false;
    // Priority spans + `dense` auto-placement can pull non-priority tiles into the
    // same top area as big tiles. Disable that when big tiles exist.
    els.grid.classList.toggle('no-dense', (layout.bigKeys || []).length > 0);
    els.grid.style.setProperty(
      '--cell-min-w',
      `${Math.max(1, layout.mins.minW)}px`
    );
    els.grid.style.setProperty(
      '--cell-min-h',
      `${Math.max(1, layout.mins.minH)}px`
    );
    els.grid.style.setProperty('--cols', String(Math.max(1, layout.cols)));
    els.grid.style.setProperty('--rows', String(Math.max(1, layout.rows)));
    els.grid.classList.toggle('one-col', layout.n === 1);
    applyBigTileCellSpans(layout.bigKeys, layout.spanW, layout.spanH);
    scheduleTwitchProxyRefresh();
  }

  /** After a layout pass, re-tier proxy cells to match their new pixel size. */
  let twitchProxyRefreshTimer = null;
  function scheduleTwitchProxyRefresh() {
    if (twitchPlayback !== 'proxy') return;
    if (twitchProxyRefreshTimer) return;
    twitchProxyRefreshTimer = window.setTimeout(() => {
      twitchProxyRefreshTimer = null;
      requestAnimationFrame(() => {
        refreshTwitchProxyQualities();
      });
    }, 80);
  }

  function scheduleLayoutGridToViewport() {
    if (gridLayoutTimer) clearTimeout(gridLayoutTimer);
    gridLayoutTimer = setTimeout(() => {
      gridLayoutTimer = null;
      layoutGridToViewport();
    }, 120);
  }

  function visibleChannels() {
    const list = state.channels.filter((ch) => {
      if (getChannelType(ch) !== 'twitch') return true;
      if (!state.hideOffline || !apiConfigured || pollFailed) return true;
      return onlineSet.has(getTwitchLogin(ch));
    });
    if (!state.sortByViews) return list;

    const withIndex = list.map((ch, i) => {
      const login = getChannelType(ch) === 'twitch' ? getTwitchLogin(ch) : null;
      const v = login && viewerCounts.has(login) ? viewerCounts.get(login) : -1;
      return { ch, i, v };
    });
    withIndex.sort((a, b) => {
      if (b.v !== a.v) return b.v - a.v; // highest viewers first by default
      return a.i - b.i; // stable tie-break, keeps manual order for ties
    });
    let ordered = withIndex.map((x) => x.ch);
    if (state.sortByViewsInvert) ordered = ordered.reverse();
    return ordered;
  }

  /**
   * Pick up to N "big tiles" for priority mode.
   * - candidates come from state.prioritySelection (selection list in the modal)
   * - for Twitch: only pick if that channel is currently online (when onlineSet is available)
   * - for YouTube/HLS: always available, so they can be big if selected
   * - uses the same order as state.channels (and thus visible list) so it feels predictable
   */
  function priorityBigTileKeys(visible) {
    if (!state.priorityTiles) return [];
    const selection = Array.isArray(state.prioritySelection)
      ? state.prioritySelection
      : [];
    if (!selection.length) return [];

    const selectionSet = new Set(selection);
    const haveOnlineSignal = apiConfigured && !pollFailed && onlineSet.size > 0;

    const out = [];
    for (const ch of visible) {
      const key = channelKey(ch);
      if (!selectionSet.has(key)) continue;

      if (getChannelType(ch) !== 'twitch') {
        out.push(key);
        continue;
      }

      const login = getTwitchLogin(ch);
      if (haveOnlineSignal) {
        if (onlineSet.has(login)) out.push(key);
        continue;
      }
      // Without online signal, keep Twitch priority disabled (prevents offline channels being promoted).
      continue;
    }
    return out;
  }

  function visibleChannelsForLayout() {
    const v = visibleChannels();
    const bigKeys = priorityBigTileKeys(v);
    if (!bigKeys.length) return { orderedVisible: v, bigKeys: [] };

    const bigSet = new Set(bigKeys);
    const ordered = [
      ...v.filter((ch) => bigSet.has(channelKey(ch))),
      ...v.filter((ch) => !bigSet.has(channelKey(ch))),
    ];
    return { orderedVisible: ordered, bigKeys };
  }

  /** Approximate vertical split between priority band and the rest (for layout math). */
  const PRIORITY_BAND_FRAC = 0.52;
  const REST_BAND_FRAC = 0.48;

  function computeGridLayoutVars() {
    const { orderedVisible, bigKeys } = visibleChannelsForLayout();
    const n = orderedVisible.length;
    const mins = currentGridMinimums(orderedVisible);
    const vp = gridViewportSize();

    if (!bigKeys.length) {
      const { cols, rows } = gridDimensionsByStreamFit(n, vp, mins);
      return {
        split: false,
        orderedVisible,
        bigKeys: [],
        mins,
        n,
        cols,
        rows,
        spanW: 1,
        spanH: 1,
      };
    }

    const bigSet = new Set(bigKeys);
    const priorityChannels = orderedVisible.filter((ch) =>
      bigSet.has(channelKey(ch))
    );
    const restChannels = orderedVisible.filter(
      (ch) => !bigSet.has(channelKey(ch))
    );
    const nP = priorityChannels.length;
    const nR = restChannels.length;

    const hPri = Math.max(220, vp.h * PRIORITY_BAND_FRAC);
    const hRest = Math.max(200, vp.h * REST_BAND_FRAC);
    const vpPri = { w: vp.w, h: hPri };
    const vpRest = { w: vp.w, h: hRest };

    const base = gridDimensions(nP, vpPri, mins);
    let spanW = 1;
    let spanH = 1;
    if (bigKeys.length === 1) {
      spanW = base.cols >= 2 ? 2 : 1;
      spanH = base.rows >= 2 ? 2 : 1;
    } else {
      if (base.cols >= 2) {
        spanW = 2;
        spanH = 1;
      } else if (base.rows >= 2) {
        spanW = 1;
        spanH = 2;
      }
    }

    let effectiveCount = nP + bigKeys.length * (spanW * spanH - 1);
    let dims = gridDimensions(effectiveCount, vpPri, mins);
    if (dims.cols < 2) spanW = 1;
    if (dims.rows < 2) spanH = 1;
    effectiveCount = nP + bigKeys.length * (spanW * spanH - 1);
    dims = gridDimensions(effectiveCount, vpPri, mins);

    const restDims =
      nR > 0
        ? gridDimensionsByStreamFit(nR, vpRest, mins)
        : { cols: 1, rows: 1 };

    return {
      split: true,
      orderedVisible,
      bigKeys,
      mins,
      n,
      priority: {
        channels: priorityChannels,
        cols: dims.cols,
        rows: dims.rows,
        spanW,
        spanH,
      },
      rest: {
        channels: restChannels,
        cols: restDims.cols,
        rows: restDims.rows,
      },
    };
  }

  function applyPriorityGridSpans(spanW, spanH) {
    if (!els.gridPriority) return;
    for (const cell of els.gridPriority.querySelectorAll('.cell')) {
      cell.style.gridColumnEnd = `span ${spanW}`;
      cell.style.gridRowEnd = `span ${spanH}`;
      const handle = cell.querySelector('.cell-drag-handle');
      if (handle) {
        handle.style.pointerEvents = 'none';
        handle.style.cursor = 'default';
        handle.style.opacity = '0.5';
      }
    }
  }

  function clearRestGridSpans() {
    if (!els.grid) return;
    for (const cell of els.grid.querySelectorAll('.cell')) {
      cell.style.gridColumnEnd = '';
      cell.style.gridRowEnd = '';
      const handle = cell.querySelector('.cell-drag-handle');
      if (handle) {
        handle.style.pointerEvents = '';
        handle.style.cursor = '';
        handle.style.opacity = '';
      }
    }
  }

  function applyBigTileCellSpans(bigKeys, spanW, spanH) {
    const cells = els.grid ? Array.from(els.grid.querySelectorAll('.cell')) : [];
    for (const cell of cells) {
      const isBig = bigKeys && bigKeys.length > 0 && bigKeys.includes(cell.dataset.channelKey);
      cell.style.gridColumnEnd = isBig ? `span ${spanW}` : '';
      cell.style.gridRowEnd = isBig ? `span ${spanH}` : '';

      const handle = cell.querySelector('.cell-drag-handle');
      if (handle) {
        if (isBig) {
          handle.style.pointerEvents = 'none';
          handle.style.cursor = 'default';
          handle.style.opacity = '0.5';
        } else {
          handle.style.pointerEvents = '';
          handle.style.cursor = '';
          handle.style.opacity = '';
        }
      }
    }
  }

  /** Reorder only channels that are currently visible in the grid; others stay in place. */
  function applyVisibleOrder(nextVisible) {
    const visibleKeys = new Set(nextVisible.map(channelKey));
    let qi = 0;
    state.channels = state.channels.map((ch) => {
      if (visibleKeys.has(channelKey(ch))) {
        return nextVisible[qi++];
      }
      return ch;
    });
  }

  function reorderVisibleChannelsGrid(fromIndex, toIndex) {
    const { orderedVisible: v, bigKeys } = visibleChannelsForLayout();
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= v.length ||
      toIndex >= v.length
    ) {
      return;
    }
    if (bigKeys && bigKeys.length) {
      const nP = bigKeys.length;
      if ((fromIndex < nP) !== (toIndex < nP)) return;
    }
    const fromKey = channelKey(v[fromIndex]);
    const toKey = channelKey(v[toIndex]);

    const item = v[fromIndex];
    const next = v.filter((_, i) => i !== fromIndex);
    next.splice(toIndex, 0, item);
    applyVisibleOrder(next);
    saveState();
    fullRender();
  }

  /**
   * Stable signature of the current grid — used to skip rebuild when polling
   * didn’t actually change *who* is shown. Intentionally order-independent: with
   * "sort by viewers" on, viewer counts (and thus rank order) shift constantly,
   * which must NOT by itself trigger a grid rebuild (that reorders/moves every
   * cell and can leave Twitch embeds paused). Only membership — which channels
   * are visible, and which are big/priority tiles — should trigger a rebuild.
   */
  function visibleChannelsSignature() {
    const { orderedVisible, bigKeys } = visibleChannelsForLayout();
    const bigSet = new Set(bigKeys);
    return orderedVisible
      .map((ch) => {
        const key = channelKey(ch);
        return bigSet.has(key) ? `${key}*` : key;
      })
      .sort()
      .join('\x1e');
  }

  function twitchLoginsForPoll() {
    return state.channels
      .filter((c) => getChannelType(c) === 'twitch')
      .map((c) => getTwitchLogin(c));
  }

  async function refreshOnline() {
    const twitchList = twitchLoginsForPoll();
    if (!twitchList.length) {
      onlineSet = new Set();
      viewerCounts = new Map();
      pollFailed = false;
      return;
    }
    try {
      const q = twitchList.join(',');
      const res = await fetch(
        `/api/streams?login=${encodeURIComponent(q)}`,
        FETCH_OPTS
      );
      const data = await res.json();
      if (!res.ok) {
        pollFailed = true;
        setMeta(data.error || `Stream check failed (${res.status})`, true);
        return;
      }
      pollFailed = false;
      apiConfigured = Boolean(data.configured);
      if (data.error && data.configured) {
        setMeta(data.error, true);
      } else if (!data.configured) {
        setMeta(
          'Add Twitch app credentials to .env for live/offline detection.',
          true
        );
      } else {
        setMeta('', false);
      }
      onlineSet = new Set((data.online || []).map((s) => s.toLowerCase()));
      const nextViewerCounts = new Map();
      for (const [login, count] of Object.entries(data.viewers || {})) {
        nextViewerCounts.set(login.toLowerCase(), count);
      }
      viewerCounts = nextViewerCounts;
    } catch {
      pollFailed = true;
      setMeta('Could not reach /api/streams — is the server running?', true);
    }
  }

  function setMeta(text, warn) {
    els.toolbarMeta.textContent = text;
    els.toolbarMeta.classList.toggle('warn', Boolean(warn && text));
  }

  async function refreshAuth() {
    if (!els.authLogin || !els.authUserWrap) return;
    try {
      const res = await fetch('/api/me', FETCH_OPTS);
      const data = await res.json();
      if (data.authenticated && data.user) {
        els.authLogin.hidden = true;
        els.authUserWrap.hidden = false;
        els.authUserLabel.textContent =
          data.user.displayName || data.user.login || '';
        if (data.user.profileImageUrl) {
          els.authAvatar.src = data.user.profileImageUrl;
          els.authAvatar.hidden = false;
        } else {
          els.authAvatar.removeAttribute('src');
          els.authAvatar.hidden = true;
        }
      } else {
        els.authLogin.hidden = false;
        els.authUserWrap.hidden = true;
      }
    } catch {
      els.authLogin.hidden = false;
      els.authUserWrap.hidden = true;
    }
  }

  /* --- Channel points auto-claim (separate Twitch web-session) --- */

  let pointsLinked = false;
  let pointsPollTimer = null;
  let pointsStatusTimer = null;

  async function refreshPointsAuth() {
    try {
      const res = await fetch('/api/points-auth/status', FETCH_OPTS);
      const data = await res.json();
      pointsLinked = Boolean(data.linked);
      if (els.linkPoints) {
        els.linkPoints.textContent = pointsLinked
          ? `Points: ${data.login || 'linked'}`
          : 'Link for points';
      }
    } catch {
      /* non-critical */
    }
  }

  async function startPointsLink() {
    if (!els.pointsModal) return;
    els.pointsModal.hidden = false;
    els.pointsModal.setAttribute('aria-hidden', 'false');
    els.pointsDeviceCode.hidden = true;
    els.pointsLinked.hidden = true;
    els.pointsUnlink.hidden = true;

    /* Check if already linked */
    try {
      const res = await fetch('/api/points-auth/status', FETCH_OPTS);
      const data = await res.json();
      if (data.linked) {
        showPointsLinked(data.login);
        return;
      }
    } catch { /* continue to device flow */ }

    /* Start device code flow */
    try {
      const res = await fetch('/api/points-auth/device', {
        ...FETCH_OPTS,
        method: 'POST',
      });
      const data = await res.json();
      if (data.error) {
        if (els.pointsPollingStatus) {
          els.pointsPollingStatus.textContent = `Error: ${data.error}`;
        }
        els.pointsDeviceCode.hidden = false;
        return;
      }
      els.pointsDeviceCode.hidden = false;
      els.pointsDeviceUrl.textContent = data.verificationUri;
      els.pointsCodeDisplay.textContent = data.userCode;
      els.pointsPollingStatus.textContent = 'Waiting for authorization…';
      /* Start polling for completion */
      startPointsPolling();
    } catch (e) {
      if (els.pointsPollingStatus) {
        els.pointsPollingStatus.textContent = `Error: ${e.message}`;
      }
      els.pointsDeviceCode.hidden = false;
    }
  }

  function startPointsPolling() {
    if (pointsPollTimer) clearInterval(pointsPollTimer);
    pointsPollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/points-auth/poll', FETCH_OPTS);
        const data = await res.json();
        if (data.status === 'linked') {
          clearInterval(pointsPollTimer);
          pointsPollTimer = null;
          pointsLinked = true;
          if (els.linkPoints) {
            els.linkPoints.textContent = `Points: ${data.login || 'linked'}`;
          }
          showPointsLinked(data.login);
          syncPointsWatch();
        } else if (data.status === 'expired') {
          clearInterval(pointsPollTimer);
          pointsPollTimer = null;
          if (els.pointsPollingStatus) {
            els.pointsPollingStatus.textContent = 'Code expired. Close and try again.';
          }
        } else if (data.status === 'error') {
          clearInterval(pointsPollTimer);
          pointsPollTimer = null;
          if (els.pointsPollingStatus) {
            els.pointsPollingStatus.textContent = `Error: ${data.error}`;
          }
        }
        /* status === 'pending' → keep polling */
      } catch {
        /* ignore — will retry next interval */
      }
    }, 5000);
  }

  function showPointsLinked(login) {
    els.pointsDeviceCode.hidden = true;
    els.pointsLinked.hidden = false;
    els.pointsUnlink.hidden = false;
    els.pointsLinkedLogin.textContent = login || 'linked';
    refreshPointsStatus();
  }

  async function refreshPointsStatus() {
    if (!pointsLinked) return;
    try {
      const res = await fetch('/api/points/status', FETCH_OPTS);
      const data = await res.json();
      if (data.totalClaimed > 0 && els.pointsClaimsSummary) {
        els.pointsClaimsSummary.textContent = `Auto-claimed ${data.totalClaimed} points so far.`;
      }
      /* Show a small indicator in the toolbar meta area */
      if (els.toolbarMeta && data.totalClaimed > 0) {
        const existing = els.toolbarMeta.querySelector('.points-indicator');
        if (existing) existing.remove();
        const span = document.createElement('span');
        span.className = 'points-indicator';
        span.textContent = `Auto-claimed ${data.totalClaimed} pts`;
        els.toolbarMeta.appendChild(span);
      }
    } catch {
      /* ignore */
    }
  }

  /** Send the current Twitch logins to the server so the poller knows which
   *  channels to watch for bonus claims. */
  async function syncPointsWatch() {
    if (!pointsLinked) return;
    const logins = twitchChannelsForChat();
    if (!logins.length) return;
    try {
      await fetch('/api/points/watch', {
        ...FETCH_OPTS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logins }),
      });
    } catch {
      /* non-critical — will retry on next fullRender */
    }
  }

  async function unlinkPoints() {
    try {
      await fetch('/api/points-auth/logout', {
        ...FETCH_OPTS,
        method: 'POST',
      });
    } catch { /* ignore */ }
    pointsLinked = false;
    if (els.linkPoints) els.linkPoints.textContent = 'Link for points';
    els.pointsLinked.hidden = true;
    els.pointsUnlink.hidden = true;
    els.pointsDeviceCode.hidden = true;
    closePointsModal();
    /* Remove the toolbar indicator */
    if (els.toolbarMeta) {
      const existing = els.toolbarMeta.querySelector('.points-indicator');
      if (existing) existing.remove();
    }
  }

  function closePointsModal() {
    if (pointsPollTimer) {
      clearInterval(pointsPollTimer);
      pointsPollTimer = null;
    }
    if (els.pointsModal) {
      els.pointsModal.hidden = true;
      els.pointsModal.setAttribute('aria-hidden', 'true');
    }
  }

  function syncFollowModalFromState() {
    followModalSelection = new Set(
      state.channels
        .filter(
          (c) =>
            getChannelType(c) === 'twitch' &&
            state.importedFollows.includes(getTwitchLogin(c))
        )
        .map((c) => getTwitchLogin(c))
    );
  }

  function updateFollowModalCount() {
    if (!els.followCount) return;
    const n = state.importedFollows.length;
    els.followCount.textContent = `${followModalSelection.size} selected · ${n} imported`;
  }

  function renderFollowModalRows() {
    if (!els.followList) return;
    const q = (els.followFilter && els.followFilter.value.trim().toLowerCase()) || '';
    els.followList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const login of state.importedFollows) {
      if (q && !login.includes(q)) continue;
      const row = document.createElement('label');
      row.className = 'follow-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = followModalSelection.has(login);
      cb.dataset.login = login;
      cb.addEventListener('change', () => {
        if (cb.checked) followModalSelection.add(login);
        else followModalSelection.delete(login);
        updateFollowModalCount();
      });
      const span = document.createElement('span');
      span.textContent = login;
      row.appendChild(cb);
      row.appendChild(span);
      frag.appendChild(row);
    }
    els.followList.appendChild(frag);
    updateFollowModalCount();
  }

  function openFollowModal() {
    if (!els.followModal) return;
    if (els.followFilter) els.followFilter.value = '';
    renderFollowModalRows();
    els.followModal.hidden = false;
    els.followModal.setAttribute('aria-hidden', 'false');
    if (els.followFilter) els.followFilter.focus();
  }

  function closeFollowModal() {
    if (!els.followModal) return;
    els.followModal.hidden = true;
    els.followModal.setAttribute('aria-hidden', 'true');
  }

  function applyFollowModalSave() {
    const importing = state.importedFollows.filter((c) =>
      followModalSelection.has(c)
    );
    const kept = state.channels.filter((c) => {
      if (getChannelType(c) !== 'twitch') return true;
      const login = getTwitchLogin(c);
      if (!state.importedFollows.includes(login)) return true;
      return importing.includes(login);
    });
    const added = importing
      .filter(
        (login) =>
          !state.channels.some(
            (c) =>
              getChannelType(c) === 'twitch' && getTwitchLogin(c) === login
          )
      )
      .map((login) => ({ type: 'twitch', login }));
    state.channels = [...kept, ...added];
    saveState();
    closeFollowModal();
    tick().then(() => {
      fullRender();
      schedulePoll();
    });
    setMeta(
      `${importing.length} channel(s) enabled from your follows (plus manual adds).`,
      false
    );
  }

  function updateFollowImportButtonsVisibility() {
    if (els.editFollowSelection) {
      els.editFollowSelection.hidden = state.importedFollows.length === 0;
    }
  }

  function updatePriorityEditButtonVisibility() {
    if (els.priorityEditSelection) {
      els.priorityEditSelection.hidden = state.channels.length === 0;
    }
  }

  function syncPriorityModalFromState() {
    priorityModalSelection = new Set(state.prioritySelection || []);
  }

  function updatePriorityModalCount() {
    if (!els.priorityCount) return;
    els.priorityCount.textContent = `${priorityModalSelection.size} selected`;
  }

  function renderPriorityModalRows() {
    if (!els.priorityList) return;
    const q = (els.priorityFilter && els.priorityFilter.value.trim().toLowerCase()) || '';
    els.priorityList.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const ch of state.channels) {
      const key = channelKey(ch);
      const lbl = formatChannelLabel(ch);
      if (q && !lbl.toLowerCase().includes(q)) continue;

      const row = document.createElement('label');
      row.className = 'follow-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = priorityModalSelection.has(key);
      cb.dataset.key = key;
      cb.addEventListener('change', () => {
        if (cb.checked) priorityModalSelection.add(key);
        else priorityModalSelection.delete(key);
        updatePriorityModalCount();
      });

      const span = document.createElement('span');
      span.textContent = lbl;
      row.appendChild(cb);
      row.appendChild(span);
      frag.appendChild(row);
    }

    els.priorityList.appendChild(frag);
    updatePriorityModalCount();
  }

  function openPriorityModal() {
    if (!els.priorityModal) return;
    if (els.priorityFilter) els.priorityFilter.value = '';
    syncPriorityModalFromState();
    renderPriorityModalRows();
    els.priorityModal.hidden = false;
    els.priorityModal.setAttribute('aria-hidden', 'false');
    if (els.priorityFilter) els.priorityFilter.focus();
  }

  function closePriorityModal() {
    if (!els.priorityModal) return;
    els.priorityModal.hidden = true;
    els.priorityModal.setAttribute('aria-hidden', 'true');
  }

  function applyPriorityModalSave() {
    state.prioritySelection = [...priorityModalSelection];
    saveState();
    closePriorityModal();
    setMeta(
      `${state.prioritySelection.length} priority tile(s) selected.`,
      false
    );
    // Rebuild grid so priority / non-priority split updates immediately.
    if (state.priorityTiles) fullRender();
  }

  function renderChannelChips() {
    els.channelList.innerHTML = '';
    state.channels.forEach((ch, index) => {
      const key = channelKey(ch);
      const lbl = formatChannelLabel(ch);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.draggable = true;
      chip.dataset.index = String(index);
      chip.dataset.key = key;
      if (
        getChannelType(ch) === 'twitch' &&
        state.hideOffline &&
        apiConfigured &&
        !pollFailed &&
        !onlineSet.has(getTwitchLogin(ch))
      ) {
        chip.classList.add('offline-badge');
      }
      const label = document.createElement('span');
      label.textContent = lbl;
      chip.appendChild(label);
      if (getChannelType(ch) === 'twitch' && ch.fromCategory) {
        const cat = state.categoryFollows.find((c) => c.id === ch.fromCategory);
        chip.title = cat
          ? `Auto-added: top live stream in "${cat.name}"`
          : 'Auto-added from a followed game category';
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.setAttribute('aria-label', `Remove ${lbl}`);
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.channels = state.channels.filter((c) => channelKey(c) !== key);
        saveState();
        fullRender();
        schedulePoll();
      });
      chip.appendChild(rm);

      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(index));
        chip.style.opacity = '0.5';
      });
      chip.addEventListener('dragend', () => {
        chip.style.opacity = '';
      });
      chip.addEventListener('dragover', (e) => e.preventDefault());
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = index;
        if (Number.isNaN(from) || from === to) return;
        const next = [...state.channels];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        state.channels = next;
        saveState();
        renderChannelChips();
        renderGrid();
      });

      els.channelList.appendChild(chip);
    });
  }

  function renderCategoryChips() {
    if (!els.categoryList) return;
    els.categoryList.innerHTML = '';
    for (const cat of state.categoryFollows) {
      const count = state.channels.filter(
        (c) => getChannelType(c) === 'twitch' && c.fromCategory === cat.id
      ).length;
      const chip = document.createElement('span');
      chip.className = 'chip category-chip';
      chip.title = cat.limit
        ? `Follows the top ${cat.limit} live stream(s) in "${cat.name}"`
        : `Follows every live stream in "${cat.name}"`;
      const label = document.createElement('span');
      label.textContent = cat.limit
        ? `🎮 ${cat.name} (${count}/${cat.limit})`
        : `🎮 ${cat.name} (${count} live)`;
      chip.appendChild(label);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.setAttribute('aria-label', `Stop following ${cat.name}`);
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.categoryFollows = state.categoryFollows.filter(
          (c) => c.id !== cat.id
        );
        state.channels = state.channels.filter(
          (c) => !(getChannelType(c) === 'twitch' && c.fromCategory === cat.id)
        );
        saveState();
        fullRender();
        schedulePoll();
        scheduleCategoryPoll();
      });
      chip.appendChild(rm);
      els.categoryList.appendChild(chip);
    }
  }

  /**
   * Fetch live streams for each followed game category and merge them into
   * state.channels (tagged with `fromCategory`), adding newly-live streamers and
   * dropping ones that fell out of the list (unless the user also added them
   * manually, in which case the plain entry is left alone).
   * @returns {Promise<boolean>} whether state.channels changed
   */
  async function refreshCategoryFollows() {
    if (!state.categoryFollows.length) return false;
    let changed = false;
    for (const cat of state.categoryFollows) {
      try {
        const params = { name: cat.name };
        if (cat.limit) {
          params.first = String(cat.limit);
        } else {
          params.all = '1';
        }
        const res = await fetch(
          `/api/category-streams?${new URLSearchParams(params)}`,
          FETCH_OPTS
        );
        const data = await res.json();
        if (!res.ok || data.error) continue;

        const desiredLogins = (data.streams || [])
          .map((s) => s.login)
          .filter(Boolean);
        const desiredSet = new Set(desiredLogins);

        const before = state.channels.length;
        state.channels = state.channels.filter((c) => {
          if (getChannelType(c) !== 'twitch' || c.fromCategory !== cat.id) {
            return true;
          }
          return desiredSet.has(getTwitchLogin(c));
        });
        if (state.channels.length !== before) changed = true;

        for (const login of desiredLogins) {
          const exists = state.channels.some(
            (c) => getChannelType(c) === 'twitch' && getTwitchLogin(c) === login
          );
          if (exists) continue;
          state.channels.push({ type: 'twitch', login, fromCategory: cat.id });
          changed = true;
        }
      } catch {
        /* keep existing channels for this category on network errors */
      }
    }
    if (changed) saveState();
    return changed;
  }

  /** Faster dedicated poll for category follows so new/ended streams appear without a reload. */
  async function categoryTick() {
    const before = visibleChannelsSignature();
    const changed = await refreshCategoryFollows();
    if (changed) {
      await refreshOnline();
    }
    renderChannelChips();
    renderCategoryChips();
    if (changed || visibleChannelsSignature() !== before) {
      renderGrid();
    }
  }

  function scheduleCategoryPoll() {
    if (categoryPollTimer) clearInterval(categoryPollTimer);
    categoryPollTimer = null;
    if (state.categoryFollows.length > 0) {
      categoryPollTimer = setInterval(categoryTick, CATEGORY_POLL_MS);
    }
  }

  async function promptAddCategoryFollow() {
    const raw = window.prompt(
      'Twitch game/category to follow — every live stream in it is added automatically.\n' +
        'Optionally add :N to cap how many are shown, e.g. "Just Chatting:10".'
    );
    if (raw == null) return;
    let name = raw.trim();
    if (!name) return;
    let limit = null;
    const m = name.match(/^(.*):(\d{1,3})$/);
    if (m) {
      name = m[1].trim();
      const n = parseInt(m[2], 10);
      if (Number.isFinite(n) && n >= 1) limit = Math.min(n, 100);
    }
    if (!name) return;

    setMeta(`Looking up "${name}"…`, false);
    try {
      const params = { name };
      if (limit) {
        params.first = String(limit);
      } else {
        params.all = '1';
      }
      const res = await fetch(
        `/api/category-streams?${new URLSearchParams(params)}`,
        FETCH_OPTS
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        setMeta(data.error || `Could not find category "${name}"`, true);
        return;
      }
      const id = data.gameId;
      const displayName = data.gameName || name;
      if (state.categoryFollows.some((c) => c.id === id)) {
        setMeta(`Already following ${displayName}.`, true);
        return;
      }
      state.categoryFollows.push({ id, name: displayName, limit });
      saveState();
      await refreshCategoryFollows();
      setMeta(
        limit
          ? `Following ${displayName} (up to ${limit} live stream(s)).`
          : `Following ${displayName} (every live stream).`,
        false
      );
      fullRender();
      schedulePoll();
      scheduleCategoryPoll();
    } catch {
      setMeta(
        'Could not reach /api/category-streams — is the server running?',
        true
      );
    }
  }

  function renderChatSelect() {
    /* Drop per-tile chats for channels that are no longer in the grid so
       state.cellChats doesn't keep growing as channels are added/removed. */
    if (state.cellChats.length) {
      const twitchList = twitchChannelsForChat();
      const valid = new Set(twitchList);
      const filtered = state.cellChats.filter((l) => valid.has(l));
      if (filtered.length !== state.cellChats.length) {
        state.cellChats = filtered;
        saveState();
      }
    }
  }

  function destroyCellMedia(cell) {
    if (!cell) return;
    if (cell._twitchIframeResizeObserver) {
      try {
        cell._twitchIframeResizeObserver.disconnect();
      } catch {
        /* ignore */
      }
      cell._twitchIframeResizeObserver = null;
    }
    if (cell._twitchPlayer) {
      try {
        const t = cell._twitchPlayer;
        if (t instanceof HTMLIFrameElement) {
          t.remove();
        } else if (typeof t.destroy === 'function') {
          t.destroy();
        }
      } catch {
        /* ignore */
      }
      cell._twitchPlayer = null;
    }
    cell.querySelectorAll('video.cell-video').forEach((video) => {
      if (video._hls) {
        try {
          video._hls.destroy();
        } catch {
          /* ignore */
        }
        video._hls = null;
      }
    });
    /* Drop the per-tile chat iframe so it doesn't keep loading in the background
       after the cell is removed from the grid. */
    const chatWrap = cell.querySelector('.cell-chat-wrap');
    if (chatWrap) chatWrap.innerHTML = '';
  }

  function disconnectCellObservers() {
    cellObservers.forEach((o) => o.disconnect());
    cellObservers = [];
  }

  function isTwitchPlayerIframe(iframe) {
    try {
      if (iframe && iframe.dataset && iframe.dataset.twitchEmbed === '1') {
        return true;
      }
      const s = iframe && iframe.src ? iframe.src : '';
      return s.includes('player.twitch.tv');
    } catch {
      return false;
    }
  }

  function attachCellObserversToGrid() {
    if (!els.grid || typeof IntersectionObserver === 'undefined') return;

    const cells = [
      ...els.grid.querySelectorAll('.cell'),
      ...(els.gridPriority
        ? els.gridPriority.querySelectorAll('.cell')
        : []),
    ];
    cells.forEach((cell) => {
      const iframe = cell.querySelector('iframe');
      const video = cell.querySelector('video.cell-video');
      if (!iframe && !video) return;

      const obs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const visible = entry.isIntersecting;
            if (iframe) {
              /* Never unload Twitch’s player by swapping src — reload breaks autoplay
                 and Twitch re-checks minimum size/visibility on load. YouTube-only. */
              if (!isTwitchPlayerIframe(iframe)) {
                if (!visible) {
                  if (
                    iframe.src &&
                    iframe.src !== 'about:blank' &&
                    !iframe.dataset._offscreenSrc
                  ) {
                    iframe.dataset._offscreenSrc = iframe.src;
                    iframe.src = 'about:blank';
                  }
                } else if (iframe.dataset._offscreenSrc) {
                  iframe.src = iframe.dataset._offscreenSrc;
                  delete iframe.dataset._offscreenSrc;
                }
              }
            }
            if (video) {
              const hls = video._hls;
              if (!visible) {
                video.pause();
                if (hls && typeof hls.stopLoad === 'function') {
                  try {
                    hls.stopLoad();
                  } catch {
                    /* ignore */
                  }
                }
              } else {
                if (hls && typeof hls.startLoad === 'function') {
                  try {
                    hls.startLoad();
                  } catch {
                    /* ignore */
                  }
                }
                video.play().catch(() => {});
              }
            }
          });
        },
        { root: null, rootMargin: '120px', threshold: 0.1 }
      );
      obs.observe(cell);
      cellObservers.push(obs);
    });
  }

  /** @type {{ fromIndex: number; pointerId: number; handle: HTMLElement; sourceCell: HTMLElement } | null} */
  let gridDragState = null;
  let gridDragBound = false;

  function clearGridDragOver() {
    if (!els.gridArea) return;
    els.gridArea.querySelectorAll('.cell.cell-drag-over').forEach((el) => {
      el.classList.remove('cell-drag-over');
    });
  }

  function endGridDragListeners() {
    document.removeEventListener('pointermove', onGridPointerMove);
    document.removeEventListener('pointerup', onGridPointerUp);
    document.removeEventListener('pointercancel', onGridPointerUp);
  }

  function gridAreaContainsCell(cell) {
    return (
      cell &&
      (els.grid.contains(cell) ||
        (els.gridPriority && els.gridPriority.contains(cell)))
    );
  }

  function onGridPointerMove(e) {
    if (!gridDragState || !els.grid) return;
    clearGridDragOver();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest('.cell');
    if (cell && gridAreaContainsCell(cell)) {
      cell.classList.add('cell-drag-over');
    }
  }

  function onGridPointerUp(e) {
    if (!gridDragState || !els.grid) return;
    const { fromIndex, pointerId, handle, sourceCell } = gridDragState;
    const x = e.clientX;
    const y = e.clientY;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.remove('grid-dragging');
    sourceCell.classList.remove('cell-dragging');
    clearGridDragOver();
    endGridDragListeners();

    const under = document.elementFromPoint(x, y);
    const targetCell = under && under.closest('.cell');
    if (targetCell && gridAreaContainsCell(targetCell)) {
      const toIndex = parseInt(targetCell.dataset.cellIndex || '', 10);
      if (!Number.isNaN(toIndex) && fromIndex !== toIndex) {
        reorderVisibleChannelsGrid(fromIndex, toIndex);
      }
    }
    gridDragState = null;
  }

  function onGridPointerDown(e) {
    const handle = e.target && e.target.closest('.cell-drag-handle');
    if (!handle || !gridAreaContainsCell(handle)) return;
    const cell = handle.closest('.cell');
    if (!cell || !gridAreaContainsCell(cell)) return;
    e.preventDefault();
    const fromIndex = parseInt(cell.dataset.cellIndex || '', 10);
    if (Number.isNaN(fromIndex)) return;
    gridDragState = {
      fromIndex,
      pointerId: e.pointerId,
      handle,
      sourceCell: cell,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.add('grid-dragging');
    cell.classList.add('cell-dragging');
    document.addEventListener('pointermove', onGridPointerMove);
    document.addEventListener('pointerup', onGridPointerUp);
    document.addEventListener('pointercancel', onGridPointerUp);
  }

  function setupGridDrag() {
    if (!els.gridArea || gridDragBound) return;
    gridDragBound = true;
    els.gridArea.addEventListener('pointerdown', onGridPointerDown);
  }

  /**
   * HLS playback in a cell (hls.js). Used for raw m3u8 URLs and for Twitch when server uses streamlink.
   * @param {{ twitchHls?: boolean }} opts
   */
  function mountHlsVideoInCell(cell, ch, playbackUrl, opts) {
    const twitchHls = Boolean(opts && opts.twitchHls);
    const video = document.createElement('video');
    video.className = 'cell-video';
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.autoplay = state.autoplay;

    const fail = (msg) => {
      if (cell.querySelector('.cell-hls-error')) return;
      const errEl = document.createElement('div');
      errEl.className = 'cell-hls-error';
      errEl.textContent = msg;
      cell.appendChild(errEl);
    };

    function formatHlsFatalError(data) {
      const details = data && data.details ? String(data.details) : '';
      const typ = data && data.type != null ? String(data.type) : '';
      if (twitchHls) {
        if (
          details.includes('manifestLoadError') ||
          details.includes('levelLoadError') ||
          details.includes('fragLoadError') ||
          typ === 'networkError'
        ) {
          return 'Twitch HLS: could not load playlist (offline stream, or streamlink not working on the server — see server log).';
        }
        return `Twitch HLS failed: ${details || typ || 'unknown'}.`;
      }
      if (
        details.includes('bufferAppendError') ||
        details.includes('fragParsingError') ||
        details.includes('bufferAddCodecError')
      ) {
        if (ch.transcode) {
          return 'Transcoded stream failed — check the server console for ffmpeg errors.';
        }
        return 'Browser cannot decode this stream (often MPEG-2 or AC3 in .ts). Try transcode:URL (needs ffmpeg) or Safari.';
      }
      if (
        details.includes('manifestLoadError') ||
        details.includes('levelLoadError') ||
        details.includes('fragLoadError') ||
        typ === 'networkError'
      ) {
        return 'Could not load playlist or segments (network, 403, or CORS). Check the URL.';
      }
      return `Playback failed: ${details || typ || 'unknown'}.`;
    }

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        // Offload MPEG-TS demuxing + fMP4 remuxing to a Web Worker per stream.
        // With this disabled, 4+ streams do all demux work on the main thread
        // and compete with rendering → high CPU and jank.
        enableWorker: true,
        ...(twitchHls
          ? {
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
              backBufferLength: 30,
              liveSyncDurationCount: 4,
              liveMaxLatencyDurationCount: 12,
              maxLiveSyncPlaybackRate: 1.5,
              // Twitch CDN URLs expire after ~1-2 min. When a segment fetch fails (503 from
              // our proxy), hls.js retries the same URL. With the default 6 retries it gives
              // up in ~30s and declares a fatal error — killing the tile. Bump retries so
              // it survives until the playlist reloads with fresh segment URLs (the server
              // invalidates its cache on 403/404, so the next playlist poll re-resolves).
              fragLoadingMaxRetry: 20,
              fragLoadingRetryDelay: 500,
              fragLoadingMaxRetryTimeout: 8000,
              manifestLoadingMaxRetry: 8,
              manifestLoadingRetryDelay: 500,
              levelLoadingMaxRetry: 8,
              levelLoadingRetryDelay: 500,
            }
          : {}),
      });
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      video._hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (state.autoplay) video.play().catch(() => {});
      });
      // Log pause events for diagnostics — the user reports random pauses with no
      // console errors, so we need to see what state the video/hls is in when it pauses.
      if (twitchHls) {
        video.addEventListener('pause', () => {
          const r = cell.getBoundingClientRect();
          const onScreen = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
          console.log(
            `[twitchviewer] PAUSE ch=${video._twitchLogin || '?'} q=${video._twitchQuality || '?'} ` +
            `onScreen=${onScreen} autoplay=${state.autoplay} ` +
            `readyState=${video.readyState} networkState=${video.networkState} ` +
            `paused=${video.paused} ended=${video.ended} ` +
            `hlsCurrentLevel=${hls.currentLevel} hlsLoadLevel=${hls.loadLevel} ` +
            `bufferEnd=${hls.bufferEnd ? hls.bufferEnd.toFixed(1) : '?'}`
          );
        });
        video.addEventListener('play', () => {
          console.log(`[twitchviewer] PLAY  ch=${video._twitchLogin || '?'} q=${video._twitchQuality || '?'}`);
        });
      }
      hls.on(Hls.Events.ERROR, (_, data) => {
        // Log ALL errors (fatal and non-fatal) for Twitch streams so we can see what's
        // happening before the video pauses.
        if (twitchHls) {
          console.log(
            `[twitchviewer] HLS ERROR ch=${video._twitchLogin || '?'} ` +
            `fatal=${data.fatal} type=${data.type} details=${data.details}`
          );
        }
        // Non-fatal buffer stall: the browser auto-pauses when the buffer underruns.
        // hls.js refills the buffer but does NOT call video.play() — so the video stays
        // paused. Wait for hls.js to append new data, then resume playback.
        if (!data.fatal && twitchHls && data.details === 'bufferStalledError') {
          if (state.autoplay) {
            const resumeOnBuffer = () => {
              if (!video.isConnected) return;
              if (video.paused && !video.ended && state.autoplay) {
                video.play().catch(() => {});
                console.log(`[twitchviewer] RESUME after stall ch=${video._twitchLogin || '?'}`);
              }
            };
            // Give hls.js 2s to append new segments, then resume.
            setTimeout(resumeOnBuffer, 2000);
          }
          return;
        }
        if (!data.fatal) return;
        // hls.js's recommended recovery: network error → startLoad() (reloads playlist,
        // which hits our proxy with a fresh resolve → fresh CDN URLs). Media error →
        // recoverMediaError() (resets the media element internally).
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { hls.startLoad(); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch { /* ignore */ }
          return;
        }
        fail(formatHlsFatalError(data));
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playbackUrl;
      if (state.autoplay) video.play().catch(() => {});
    } else {
      fail('HLS not supported in this browser.');
    }

    cell.appendChild(video);
    const lab = document.createElement('div');
    lab.className = 'cell-label';
    lab.textContent = formatChannelLabel(ch);
    cell.appendChild(lab);
  }

  /** Per-tile Twitch chat: a small toggle button on the tile that splits the
   *  tile into VIDEO | CHAT when active. Each stream can show its own chat
   *  simultaneously — useful on a large portrait display where a single shared
   *  chat is hard to read.
   *
   *  Preloading: the chat iframe is created on tile mount (staggered to avoid
   *  bursting Twitch's embed endpoint), kept hidden via CSS. When the user
   *  clicks the toggle, the already-loaded iframe is just revealed — instant.
   *  This means all visible tiles' chats load in the background, so any toggle
   *  is snappy. The trade-off is more network/memory (one chat iframe per
   *  Twitch tile), which is acceptable since chat iframes are lightweight. */
  function attachCellChatToggle(cell, login) {
    if (!login) return;
    cell.dataset.twitchLogin = login;

    const wrap = document.createElement('div');
    wrap.className = 'cell-chat-wrap';
    wrap.setAttribute('aria-hidden', 'true');
    cell.appendChild(wrap);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell-chat-toggle';
    btn.title = 'Show chat for this stream';
    btn.textContent = 'Chat';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const open = cell.classList.contains('cell-chat-open');
      setCellChatOpen(cell, login, !open);
    });
    cell.appendChild(btn);

    /* Expand button: temporarily overlays the chat across the entire tile so
       Twitch's channel-points popup (which clips at normal width) has enough
       room. Click again to collapse back to VIDEO | CHAT. */
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'cell-chat-expand';
    expandBtn.title = 'Expand chat (for channel points)';
    expandBtn.textContent = '⤢';
    expandBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleCellChatExpand(cell);
    });
    cell.appendChild(expandBtn);

    /* Stagger chat iframe creation across tiles so we don't fire 15+ embed
       requests at Twitch simultaneously. The queue serializes preload creation
       with a small delay between each. */
    chatPreloadQueue = chatPreloadQueue.then(() =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          preloadCellChat(cell, login);
          resolve();
        });
      })
    );

    if (state.cellChats.includes(login)) {
      showCellChat(cell);
    }
  }

  /** Create the chat iframe in the wrap (if not already there). The wrap stays
   *  hidden via CSS until showCellChat is called. The iframe loads in the
   *  background regardless of the wrap's display state. */
  function preloadCellChat(cell, login) {
    const wrap = cell.querySelector('.cell-chat-wrap');
    if (!wrap) return;
    if (wrap.querySelector('iframe')) return; /* already preloaded */
    const iframe = document.createElement('iframe');
    iframe.src = chatSrc(login);
    iframe.title = `Twitch chat: ${login}`;
    wrap.appendChild(iframe);
  }

  function showCellChat(cell) {
    cell.classList.add('cell-chat-open');
    const wrap = cell.querySelector('.cell-chat-wrap');
    if (wrap) wrap.setAttribute('aria-hidden', 'false');
    const btn = cell.querySelector('.cell-chat-toggle');
    if (btn) {
      btn.textContent = '×';
      btn.title = 'Hide chat for this stream';
      btn.setAttribute('aria-pressed', 'true');
    }
  }

  function hideCellChat(cell) {
    cell.classList.remove('cell-chat-open');
    cell.classList.remove('cell-chat-expanded');
    const wrap = cell.querySelector('.cell-chat-wrap');
    if (wrap) wrap.setAttribute('aria-hidden', 'true');
    const btn = cell.querySelector('.cell-chat-toggle');
    if (btn) {
      btn.textContent = 'Chat';
      btn.title = 'Show chat for this stream';
      btn.setAttribute('aria-pressed', 'false');
    }
    const expandBtn = cell.querySelector('.cell-chat-expand');
    if (expandBtn) {
      expandBtn.textContent = '⤢';
      expandBtn.title = 'Expand chat (for channel points)';
    }
  }

  function toggleCellChatExpand(cell) {
    const expanded = cell.classList.toggle('cell-chat-expanded');
    const expandBtn = cell.querySelector('.cell-chat-expand');
    if (expandBtn) {
      expandBtn.textContent = expanded ? '⤡' : '⤢';
      expandBtn.title = expanded
        ? 'Collapse chat back to side panel'
        : 'Expand chat (for channel points)';
    }
  }

  function setCellChatOpen(cell, login, open) {
    if (!login) return;
    const set = new Set(state.cellChats);
    if (open) {
      set.add(login);
      /* If the iframe hasn't finished preloading yet, create it now so the
         user sees something immediately rather than an empty pane. */
      preloadCellChat(cell, login);
      showCellChat(cell);
    } else {
      set.delete(login);
      hideCellChat(cell);
    }
    state.cellChats = [...set];
    saveState();
  }

  /**
   * Build one grid cell. Sets data-channel-key so we can reuse DOM across polls
   * (avoids tearing down Twitch embeds when hide-offline toggles other channels).
   */
  function buildCellForChannel(ch, cellIndex) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.cellIndex = String(cellIndex);
    cell.dataset.channelKey = channelKey(ch);
    const dragHandle = document.createElement('div');
    dragHandle.className = 'cell-drag-handle';
    dragHandle.title = 'Drag (hold) along the right edge to reorder';
    cell.appendChild(dragHandle);
    const t = getChannelType(ch);

    if (t === 'twitch') {
      const login = getTwitchLogin(ch);
      attachCellChatToggle(cell, login);
      if (twitchPlayback === 'proxy') {
        // Mount immediately with a conservative default quality (360p30). The cell may not
        // have a size yet (CSS grid hasn't reflowed), so we can't pick the right quality tier
        // — but a black screen is worse than starting at 360p and upgrading later.
        // refreshTwitchProxyQualities() runs after layout settles and reloads at the correct
        // quality for the tile's actual pixel size.
        const url = twitchProxyPlaybackUrl(login, '360p30');
        mountHlsVideoInCell(cell, ch, url, { twitchHls: true });
        const video = cell.querySelector('video.cell-video');
        if (video) {
          video._twitchQuality = '360p30';
          video._twitchLogin = login;
        }
        const lab = document.createElement('div');
        lab.className = 'cell-label';
        lab.textContent = login;
        cell.appendChild(lab);
      } else if (twitchPlayback === 'hls') {
        const playbackUrl = `${location.origin}/api/twitch-live/${encodeURIComponent(login)}/playlist.m3u8`;
        mountHlsVideoInCell(cell, ch, playbackUrl, { twitchHls: true });
      } else {
        attachTwitchEmbedCell(cell, login);
        const lab = document.createElement('div');
        lab.className = 'cell-label';
        lab.textContent = login;
        cell.appendChild(lab);
      }
    } else if (t === 'youtube') {
      const iframe = document.createElement('iframe');
      iframe.src = youtubeEmbedSrc(ch.id);
      iframe.title = `YouTube: ${ch.id}`;
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute(
        'allow',
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
      );
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.allowFullscreen = true;
      cell.appendChild(iframe);
      const lab = document.createElement('div');
      lab.className = 'cell-label';
      lab.textContent = `YT: ${ch.id}`;
      cell.appendChild(lab);
    } else if (t === 'hls') {
      const url = ch.url;
      if (ch.transcode && !ch.transcodeHash) {
        const err = document.createElement('div');
        err.className = 'cell-hls-error';
        err.textContent =
          'Transcode: missing hash — refresh the page or re-add as transcode:URL';
        cell.appendChild(err);
        const labEarly = document.createElement('div');
        labEarly.className = 'cell-label';
        labEarly.textContent = formatChannelLabel(ch);
        cell.appendChild(labEarly);
        return cell;
      }

      const playbackUrl = ch.transcode
        ? `${location.origin}/api/transcode/${ch.transcodeHash}/playlist.m3u8?source=${encodeURIComponent(url)}`
        : url;

      mountHlsVideoInCell(cell, ch, playbackUrl, {});
    }

    return cell;
  }

  function syncGridCells(gridEl, channels, globalIndexStart) {
    if (!gridEl) return;
    const desiredKeys = channels.map(channelKey);
    const n = channels.length;

    if (n === 0) {
      for (const cell of [...gridEl.querySelectorAll('.cell')]) {
        destroyCellMedia(cell);
      }
      gridEl.innerHTML = '';
      return;
    }

    const desiredSet = new Set(desiredKeys);
    for (const cell of [...gridEl.querySelectorAll('.cell')]) {
      if (!desiredSet.has(cell.dataset.channelKey)) {
        destroyCellMedia(cell);
        cell.remove();
      }
    }

    /* Never move an already-mounted cell to a different DOM position — even a
       same-parent insertBefore can make embedded Twitch/YouTube players show
       a paused/play-button overlay. Surviving cells stay exactly where they
       already are in the DOM; only their CSS `order` (grid items honor `order`
       just like flex items) changes to reflect the new visual position. */
    const existingByKey = new Map();
    for (const cell of gridEl.querySelectorAll('.cell')) {
      existingByKey.set(cell.dataset.channelKey, cell);
    }

    for (let i = 0; i < desiredKeys.length; i++) {
      const wantKey = desiredKeys[i];
      const idx = globalIndexStart + i;
      let cell = existingByKey.get(wantKey);
      if (!cell) {
        cell = buildCellForChannel(channels[i], idx);
        gridEl.appendChild(cell);
      } else {
        cell.dataset.cellIndex = String(idx);
      }
      cell.style.order = String(idx);
    }
  }

  function renderGrid() {
    disconnectCellObservers();
    const layout = computeGridLayoutVars();
    const visible = layout.orderedVisible;
    const n = visible.length;

    if (layout.split && els.gridPriority) {
      if (els.gridSplit) {
        els.gridSplit.classList.toggle(
          'priority-only',
          layout.rest.channels.length === 0
        );
      }
      els.grid.classList.remove('grid-full');
      els.grid.classList.add('grid-rest');
      els.gridPriority.hidden = false;
      els.gridPriority.classList.add('no-dense');

      const nR = layout.rest.channels.length;
      els.grid.hidden = nR === 0;
      els.grid.classList.toggle('grid-rest-hidden', nR === 0);

      if (n === 0) {
        for (const cell of [...els.gridPriority.querySelectorAll('.cell')]) {
          destroyCellMedia(cell);
        }
        els.gridPriority.innerHTML = '';
        for (const cell of [...els.grid.querySelectorAll('.cell')]) {
          destroyCellMedia(cell);
        }
        els.grid.innerHTML = '';
        twitchEmbedQueue = Promise.resolve();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => attachCellObserversToGrid());
        });
        return;
      }

      const pCh = layout.priority.channels;
      const rCh = layout.rest.channels;
      const nP = pCh.length;

      els.gridPriority.style.setProperty(
        '--cell-min-w',
        `${Math.max(1, layout.mins.minW)}px`
      );
      els.gridPriority.style.setProperty(
        '--cell-min-h',
        `${Math.max(1, layout.mins.minH)}px`
      );
      els.gridPriority.style.setProperty(
        '--cols',
        String(Math.max(1, layout.priority.cols))
      );
      els.gridPriority.style.setProperty(
        '--rows',
        String(Math.max(1, layout.priority.rows))
      );
      els.gridPriority.classList.toggle('one-col', nP === 1);

      els.grid.style.setProperty(
        '--cell-min-w',
        `${Math.max(1, layout.mins.minW)}px`
      );
      els.grid.style.setProperty(
        '--cell-min-h',
        `${Math.max(1, layout.mins.minH)}px`
      );
      els.grid.style.setProperty(
        '--cols',
        String(Math.max(1, layout.rest.cols))
      );
      els.grid.style.setProperty(
        '--rows',
        String(Math.max(1, layout.rest.rows))
      );
      els.grid.classList.toggle('one-col', nR === 1);

      syncGridCells(els.gridPriority, pCh, 0);
      syncGridCells(els.grid, rCh, nP);

      requestAnimationFrame(() => {
        applyPriorityGridSpans(layout.priority.spanW, layout.priority.spanH);
        clearRestGridSpans();
        requestAnimationFrame(() => attachCellObserversToGrid());
      });
      return;
    }

    if (els.gridSplit) els.gridSplit.classList.remove('priority-only');
    if (els.gridPriority) {
      for (const cell of [...els.gridPriority.querySelectorAll('.cell')]) {
        destroyCellMedia(cell);
      }
      els.gridPriority.innerHTML = '';
      els.gridPriority.hidden = true;
    }
    els.grid.classList.remove('grid-rest', 'grid-rest-hidden');
    els.grid.classList.add('grid-full');
    els.grid.hidden = false;

    const desiredKeys = visible.map(channelKey);

    els.grid.style.setProperty(
      '--cell-min-w',
      `${Math.max(1, layout.mins.minW)}px`
    );
    els.grid.style.setProperty(
      '--cell-min-h',
      `${Math.max(1, layout.mins.minH)}px`
    );
    els.grid.style.setProperty('--cols', String(Math.max(1, layout.cols)));
    els.grid.style.setProperty('--rows', String(Math.max(1, layout.rows)));
    els.grid.classList.toggle('one-col', n === 1);

    if (n === 0) {
      for (const cell of [...els.grid.querySelectorAll('.cell')]) {
        destroyCellMedia(cell);
      }
      els.grid.innerHTML = '';
      twitchEmbedQueue = Promise.resolve();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => attachCellObserversToGrid());
      });
      applyBigTileCellSpans(layout.bigKeys, layout.spanW, layout.spanH);
      return;
    }

    const desiredSet = new Set(desiredKeys);
    for (const cell of [...els.grid.querySelectorAll('.cell')]) {
      if (!desiredSet.has(cell.dataset.channelKey)) {
        destroyCellMedia(cell);
        cell.remove();
      }
    }

    /* Never move an already-mounted cell to a different DOM position — see
       syncGridCells for why (can make embedded players show a paused overlay).
       Surviving cells stay put; only their CSS `order` changes. */
    const existingByKey = new Map();
    for (const cell of els.grid.querySelectorAll('.cell')) {
      existingByKey.set(cell.dataset.channelKey, cell);
    }
    for (let i = 0; i < desiredKeys.length; i++) {
      const wantKey = desiredKeys[i];
      const ch = visible[i];
      let cell = existingByKey.get(wantKey);
      if (!cell) {
        cell = buildCellForChannel(ch, i);
        els.grid.appendChild(cell);
      } else {
        cell.dataset.cellIndex = String(i);
      }
      cell.style.order = String(i);
    }

    requestAnimationFrame(() => {
      applyBigTileCellSpans(layout.bigKeys, layout.spanW, layout.spanH);
      requestAnimationFrame(() => attachCellObserversToGrid());
    });
  }

  function applyToolbarLayout() {
    els.toolbar.classList.toggle('collapsed', state.toolbarCollapsed);
    els.peekTab.hidden = !state.toolbarCollapsed;
    requestAnimationFrame(() => layoutGridToViewport());
  }

  function updateRefreshStreamsButton() {
    if (!els.refreshStreams) return;
    const hasTwitchToPoll = twitchLoginsForPoll().length > 0;
    els.refreshStreams.hidden = !hasTwitchToPoll;
    els.refreshStreams.disabled = !hasTwitchToPoll;
  }

  function applySortControls() {
    if (els.sortByViews) els.sortByViews.checked = state.sortByViews;
    if (els.sortByViewsInvert) {
      els.sortByViewsInvert.checked = state.sortByViewsInvert;
    }
    if (els.sortByViewsInvertWrap) {
      els.sortByViewsInvertWrap.hidden = !state.sortByViews;
    }
  }

  function fullRender() {
    renderChannelChips();
    renderCategoryChips();
    renderChatSelect();
    applySortControls();
    applyToolbarLayout();
    renderGrid();
    updateFollowImportButtonsVisibility();
    updatePriorityEditButtonVisibility();
    updateRefreshStreamsButton();
    syncPointsWatch();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => layoutGridToViewport());
    });
  }

  async function tick() {
    const before = visibleChannelsSignature();
    await refreshOnline();
    renderChannelChips();
    renderCategoryChips();
    /* Rebuilding the grid nukes every iframe — only do it when hide-offline / live
       state actually changes who is shown. Otherwise polls every 45s would restart
       all Twitch players and feel like streams “died” for no reason. */
    if (visibleChannelsSignature() !== before) {
      renderGrid();
    }
  }

  async function refreshOnly() {
    await refreshOnline();
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (
      (state.hideOffline || state.priorityTiles) &&
      twitchLoginsForPoll().length
    ) {
      pollTimer = setInterval(tick, POLL_MS);
    }
  }

  async function ensureTranscodeHashes() {
    let changed = false;
    for (const ch of state.channels) {
      if (getChannelType(ch) === 'hls' && ch.transcode && !ch.transcodeHash) {
        try {
          const r = await fetch(
            '/api/transcode/hash?' + new URLSearchParams({ url: ch.url }),
            FETCH_OPTS
          );
          if (r.ok) {
            const j = await r.json();
            ch.transcodeHash = j.hash;
            changed = true;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (changed) saveState();
  }

  els.addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newCh = parseAddInput(els.channelInput.value);
    if (!newCh) {
      setMeta(
        'Twitch name, YouTube URL, m3u8 URL, or transcode:https://…/stream.m3u8 (needs ffmpeg for MPEG-2).',
        true
      );
      return;
    }
    if (newCh.type === 'hls' && newCh.transcode) {
      try {
        const r = await fetch(
          '/api/transcode/hash?' + new URLSearchParams({ url: newCh.url }),
          FETCH_OPTS
        );
        if (!r.ok) {
          setMeta('Could not prepare transcode.', true);
          return;
        }
        const j = await r.json();
        newCh.transcodeHash = j.hash;
        const st = await fetch('/api/transcode/status', FETCH_OPTS);
        const sj = await st.json();
        if (!sj.ffmpeg) {
          setMeta(
            'ffmpeg not found. Install ffmpeg, add it to PATH or set FFMPEG_PATH in .env, restart the server, then try transcode:… again.',
            true
          );
          return;
        }
      } catch {
        setMeta('Could not reach /api/transcode (is the server running?)', true);
        return;
      }
    }
    if (!state.channels.some((c) => channelKey(c) === channelKey(newCh))) {
      state.channels.push(newCh);
    }
    els.channelInput.value = '';
    saveState();
    setMeta('', false);
    tick().then(() => {
      fullRender();
      schedulePoll();
    });
  });

  els.hideOffline.addEventListener('change', () => {
    state.hideOffline = els.hideOffline.checked;
    saveState();
    tick().then(() => {
      fullRender();
      schedulePoll();
    });
  });

  if (els.priorityTiles) {
    els.priorityTiles.checked = state.priorityTiles;
    els.priorityTiles.addEventListener('change', () => {
      state.priorityTiles = els.priorityTiles.checked;
      saveState();
      // Rebuild layout so spanning changes immediately.
      fullRender();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => syncTwitchInteractiveQualities());
      });
    });
  }

  if (els.sortByViews) {
    els.sortByViews.checked = state.sortByViews;
    els.sortByViews.addEventListener('change', () => {
      state.sortByViews = els.sortByViews.checked;
      saveState();
      fullRender();
    });
  }

  if (els.sortByViewsInvert) {
    els.sortByViewsInvert.checked = state.sortByViewsInvert;
    els.sortByViewsInvert.addEventListener('change', () => {
      state.sortByViewsInvert = els.sortByViewsInvert.checked;
      saveState();
      fullRender();
    });
  }

  if (els.refreshStreams) {
    els.refreshStreams.addEventListener('click', async () => {
      if (!twitchLoginsForPoll().length) return;
      els.refreshStreams.disabled = true;
      try {
        await refreshOnline();
        fullRender();
        schedulePoll();
      } finally {
        updateRefreshStreamsButton();
      }
    });
  }

  if (els.followGame) {
    els.followGame.addEventListener('click', () => {
      promptAddCategoryFollow();
    });
  }

  /* Channel points: link button + modal events */
  if (els.linkPoints) {
    els.linkPoints.addEventListener('click', startPointsLink);
  }
  if (els.pointsModalCancel) {
    els.pointsModalCancel.addEventListener('click', closePointsModal);
  }
  if (els.pointsModalBackdrop) {
    els.pointsModalBackdrop.addEventListener('click', closePointsModal);
  }
  if (els.pointsUnlink) {
    els.pointsUnlink.addEventListener('click', unlinkPoints);
  }

  els.toolbarToggle.addEventListener('click', () => {
    state.toolbarCollapsed = true;
    saveState();
    applyToolbarLayout();
  });

  els.peekTab.addEventListener('click', () => {
    state.toolbarCollapsed = false;
    saveState();
    applyToolbarLayout();
  });

  els.hideOffline.checked = state.hideOffline;
  if (els.priorityTiles) {
    els.priorityTiles.checked = state.priorityTiles;
  }
  if (els.priorityEditSelection) {
    els.priorityEditSelection.addEventListener('click', () => {
      openPriorityModal();
    });
  }

  async function fetchFollowsFromApi() {
    const res = await fetch('/api/follows', FETCH_OPTS);
    const data = await res.json();
    if (!res.ok) {
      setMeta(data.error || 'Could not load follows', true);
      return null;
    }
    return [...new Set(data.logins || [])].sort();
  }

  if (els.importFollows) {
    els.importFollows.addEventListener('click', async () => {
      try {
        const newList = await fetchFollowsFromApi();
        if (!newList) return;
        state.importedFollows = newList;
        followModalSelection = new Set(
          state.channels
            .filter(
              (c) =>
                getChannelType(c) === 'twitch' &&
                newList.includes(getTwitchLogin(c))
            )
            .map((c) => getTwitchLogin(c))
        );
        saveState();
        openFollowModal();
        setMeta(
          `Loaded ${newList.length} followed channel(s). Choose which to show, then Save.`,
          false
        );
      } catch {
        setMeta('Could not import follows.', true);
      }
    });
  }

  if (els.editFollowSelection) {
    els.editFollowSelection.addEventListener('click', () => {
      syncFollowModalFromState();
      openFollowModal();
    });
  }

  if (els.followModalCancel && els.followModalBackdrop) {
    const cancel = () => closeFollowModal();
    els.followModalCancel.addEventListener('click', cancel);
    els.followModalBackdrop.addEventListener('click', cancel);
  }

  if (els.followModalSave) {
    els.followModalSave.addEventListener('click', () => applyFollowModalSave());
  }

  if (els.followSelectAll) {
    els.followSelectAll.addEventListener('click', () => {
      for (const login of state.importedFollows) followModalSelection.add(login);
      renderFollowModalRows();
    });
  }

  if (els.followSelectNone) {
    els.followSelectNone.addEventListener('click', () => {
      followModalSelection.clear();
      renderFollowModalRows();
    });
  }

  if (els.followFilter) {
    els.followFilter.addEventListener('input', () => renderFollowModalRows());
  }

  if (els.followModalRefresh) {
    els.followModalRefresh.addEventListener('click', async () => {
      try {
        const newList = await fetchFollowsFromApi();
        if (!newList) return;
        const prevSel = new Set(followModalSelection);
        state.importedFollows = newList;
        followModalSelection = new Set(
          [...prevSel].filter((c) => newList.includes(c))
        );
        saveState();
        renderFollowModalRows();
        setMeta(`Follow list updated (${newList.length} channels).`, false);
      } catch {
        setMeta('Could not refresh follows.', true);
      }
    });
  }

  if (els.priorityModalCancel && els.priorityModalBackdrop) {
    const cancel = () => closePriorityModal();
    els.priorityModalCancel.addEventListener('click', cancel);
    els.priorityModalBackdrop.addEventListener('click', cancel);
  }

  if (els.priorityModalSave) {
    els.priorityModalSave.addEventListener('click', () => applyPriorityModalSave());
  }

  if (els.prioritySelectAll) {
    els.prioritySelectAll.addEventListener('click', () => {
      for (const ch of state.channels) {
        priorityModalSelection.add(channelKey(ch));
      }
      renderPriorityModalRows();
    });
  }

  if (els.prioritySelectNone) {
    els.prioritySelectNone.addEventListener('click', () => {
      priorityModalSelection.clear();
      renderPriorityModalRows();
    });
  }

  if (els.priorityFilter) {
    els.priorityFilter.addEventListener('input', () => renderPriorityModalRows());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !els.followModal || els.followModal.hidden) return;
    closeFollowModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !els.priorityModal || els.priorityModal.hidden) return;
    closePriorityModal();
  });

  /**
   * Twitch’s player runs inside player.twitch.tv and logs vague “autoplay disabled” lines.
   * Expose a console helper so you can see *this* page’s sizes and iframe allow= flags.
   */
  function exposeTwitchAutoplayHelp() {
    window.twitchviewerAutoplayDiagnostics = function () {
      const grid = document.getElementById('grid');
      const gridPri = document.getElementById('grid-priority');
      if (!grid) {
        console.warn('[twitchviewer] No #grid');
        return;
      }
      const cells = [
        ...grid.querySelectorAll('.cell'),
        ...(gridPri ? gridPri.querySelectorAll('.cell') : []),
      ];
      console.log(
        `[twitchviewer] ${cells.length} grid cell(s). Twitch mode: ${twitchPlayback} (proxy = same-origin HLS via streamlink pass-through, quality adapts to tile size; hls = streamlink+ffmpeg transcode; iframe = Twitch embed).`
      );
      cells.forEach((cell, i) => {
        const r = cell.getBoundingClientRect();
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        const sizeOk = w >= GRID_MIN_CELL_W && h >= GRID_MIN_CELL_H;
        const iframe = cell.querySelector('iframe[src*="player.twitch.tv"]');
        const video = cell.querySelector('video.cell-video');
        if (video) {
          console.log(
            `  [${i}] ${w}×${h}px ${sizeOk ? 'OK' : 'BELOW min'} | HLS <video> (muted autoplay path)`
          );
        } else if (cell.querySelector('.twitch-embed-js-host')) {
          console.log(
            `  [${i}] ${w}×${h}px ${sizeOk ? 'OK' : 'BELOW min'} | Twitch.Player (setQuality; Priority tiles=${state.priorityTiles ? 'auto' : '~480p'})`
          );
        } else if (iframe) {
          const allow = iframe.getAttribute('allow') || '';
          const hasAllowAutoplay = /\bautoplay\b/i.test(allow);
          const src = iframe.getAttribute('src') || '';
          const parentOk = /[?&]parent=/.test(src);
          console.log(
            `  [${i}] ${w}×${h}px ${sizeOk ? 'OK' : 'BELOW min'} | iframe allow autoplay: ${hasAllowAutoplay ? 'yes' : 'MISSING'} | parent=: ${parentOk ? 'yes' : 'no'}`
          );
        } else {
          console.log(`  [${i}] ${w}×${h}px (no video/iframe yet)`);
        }
      });
    };
  }

  exposeTwitchAutoplayHelp();

  (async function init() {
    const qs = new URLSearchParams(location.search);
    const urlErr = qs.get('error');
    if (urlErr) {
      history.replaceState({}, '', location.pathname);
    }

    try {
      const st = await fetch('/api/status', FETCH_OPTS);
      const j = await st.json();
      apiConfigured = Boolean(j.configured);
      if (j.twitchPlayback === 'proxy' || j.twitchPlayback === 'hls' || j.twitchPlayback === 'iframe') {
        twitchPlayback = j.twitchPlayback;
      }
    } catch {
      apiConfigured = false;
    }
    renderChatSelect();
    await ensureTranscodeHashes();
    await refreshOnly();
    await refreshCategoryFollows();
    await refreshAuth();
    await refreshPointsAuth();
    setupGridDrag();
    fullRender();
    schedulePoll();
    scheduleCategoryPoll();
    /* Poll for points status every 60s if linked (server polls Twitch at
       the same cadence). */
    if (!pointsStatusTimer) {
      pointsStatusTimer = setInterval(refreshPointsStatus, 60_000);
    }
    console.info(
      `[twitchviewer] Twitch playback: ${twitchPlayback}. proxy = streamlink pass-through (no ffmpeg, quality per tile size); iframe = Twitch.Player (setQuality: ~480p when Priority tiles off, Auto when on); hls = legacy streamlink+ffmpeg transcode. Run twitchviewerAutoplayDiagnostics().`
    );
    window.addEventListener('resize', scheduleLayoutGridToViewport);
    document.addEventListener('fullscreenchange', scheduleLayoutGridToViewport);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleLayoutGridToViewport);
    }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => scheduleLayoutGridToViewport());
      if (els.main) ro.observe(els.main);
      if (els.gridArea) ro.observe(els.gridArea);
      if (els.gridSplit) ro.observe(els.gridSplit);
    }
    if (urlErr) {
      try {
        setMeta(decodeURIComponent(urlErr), true);
      } catch {
        setMeta(urlErr, true);
      }
    }
  })();
})();
