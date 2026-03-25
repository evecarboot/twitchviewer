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
  const FETCH_OPTS = { credentials: 'same-origin' };

  const defaultState = () => ({
    channels: [],
    importedFollows: [],
    hideOffline: false,
    priorityTiles: false,
    prioritySelection: [],
    showChat: false,
    hideChatPanel: false,
    chatOnLeft: false,
    chatForLogin: null,
    toolbarCollapsed: false,
  });

  let state = loadState();
  let apiConfigured = false;
  /** 'hls' = Twitch via streamlink+ffmpeg on server; 'iframe' = official embed */
  let twitchPlayback = 'iframe';
  let pollFailed = false;
  let onlineSet = new Set();
  let pollTimer = null;
  /** @type {IntersectionObserver[]} */
  let cellObservers = [];
  /** Stagger Twitch iframe mounts (Helix + browser load). */
  let twitchEmbedQueue = Promise.resolve();
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
    priorityTiles: document.getElementById('priority-tiles'),
    priorityEditSelection: document.getElementById('edit-priority-selection'),
    refreshStreams: document.getElementById('refresh-streams'),
    showChat: document.getElementById('show-chat'),
    hideChatPanelWrap: document.getElementById('hide-chat-panel-wrap'),
    hideChatPanel: document.getElementById('hide-chat-panel'),
    chatOnLeftWrap: document.getElementById('chat-on-left-wrap'),
    chatOnLeft: document.getElementById('chat-on-left'),
    chatChannelWrap: document.getElementById('chat-channel-wrap'),
    chatChannel: document.getElementById('chat-channel'),
    toolbarToggle: document.getElementById('toolbar-toggle'),
    toolbar: document.getElementById('toolbar'),
    peekTab: document.getElementById('peek-tab'),
    peekChat: document.getElementById('peek-chat'),
    app: document.getElementById('app'),
    main: document.getElementById('main'),
    toolbarMeta: document.getElementById('toolbar-meta'),
    channelList: document.getElementById('channel-list'),
    grid: document.getElementById('grid'),
    gridArea: document.getElementById('grid-area'),
    chatPanel: document.getElementById('chat-panel'),
    chatIframeWrap: document.getElementById('chat-iframe-wrap'),
    chatChannelPanel: document.getElementById('chat-channel-panel'),
    closeChat: document.getElementById('close-chat'),
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

  function normalizeChannelEntry(c) {
    if (typeof c === 'string') {
      const login = normalizeLogin(c);
      return login ? { type: 'twitch', login } : null;
    }
    if (!c || typeof c !== 'object') return null;
    if (c.type === 'twitch' && c.login) {
      const login = normalizeLogin(c.login);
      return login ? { type: 'twitch', login } : null;
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
      autoplay: '1',
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
   * Direct iframe embed (not Twitch.Player). Chrome/Edge need `allow="autoplay"` on the
   * iframe element; the JS API’s injected iframe often omits it, so muted autoplay fails.
   * https://dev.twitch.tv/docs/embed/video-and-clips/
   */
  function applyTwitchIframePixelSize(wrap, iframe) {
    const r = wrap.getBoundingClientRect();
    const w = Math.max(GRID_MIN_CELL_W, Math.round(r.width));
    const h = Math.max(GRID_MIN_CELL_H, Math.round(r.height));
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

  function createTwitchIframeEmbed(cell, login, wrap) {
    if (!cell.isConnected || !wrap.isConnected) return;

    try {
      wrap.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.dataset.twitchEmbed = '1';
      iframe.title = `Twitch: ${login}`;
      /* `allow` includes fullscreen — avoid duplicate allowfullscreen (Chrome warns). */
      iframe.allow =
        'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share';
      const params = new URLSearchParams();
      params.set('channel', login);
      params.set('muted', 'true');
      params.set('autoplay', 'true');
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
              createTwitchIframeEmbed(cell, login, wrap);
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
    /** Prefer #main — .grid height can be wrong before flex distributes space (e.g. fullscreen). */
    const primary = els.main || els.gridArea || els.grid;
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
  }

  function scheduleLayoutGridToViewport() {
    if (gridLayoutTimer) clearTimeout(gridLayoutTimer);
    gridLayoutTimer = setTimeout(() => {
      gridLayoutTimer = null;
      layoutGridToViewport();
    }, 120);
  }

  function visibleChannels() {
    return state.channels.filter((ch) => {
      if (getChannelType(ch) !== 'twitch') return true;
      if (!state.hideOffline || !apiConfigured || pollFailed) return true;
      return onlineSet.has(getTwitchLogin(ch));
    });
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

  function computeGridLayoutVars() {
    const { orderedVisible, bigKeys } = visibleChannelsForLayout();
    const n = orderedVisible.length;
    const mins = currentGridMinimums(orderedVisible);
    const vp = gridViewportSize();

    if (!bigKeys.length) {
      const { cols, rows } = gridDimensionsByStreamFit(n, vp, mins);
      return {
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

    // Start with an initial grid, then choose a span size that allows multiple
    // big tiles to coexist without wasting too much space.
    const base = gridDimensions(n, vp, mins);

    // If only 1 tile is big, use 2x2 for best readability.
    // With 2+ big tiles, use 2x1 (or 1x2) so multiple can be promoted together.
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

    let effectiveCount = n + bigKeys.length * (spanW * spanH - 1);
    let dims = gridDimensions(effectiveCount, vp, mins);

    // Safety: if tracks are 1-wide, prevent invalid spans.
    if (dims.cols < 2) spanW = 1;
    if (dims.rows < 2) spanH = 1;
    effectiveCount = n + bigKeys.length * (spanW * spanH - 1);
    dims = gridDimensions(effectiveCount, vp, mins);

    return {
      orderedVisible,
      bigKeys,
      mins,
      n,
      cols: dims.cols,
      rows: dims.rows,
      spanW,
      spanH,
    };
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
    const fromKey = channelKey(v[fromIndex]);
    const toKey = channelKey(v[toIndex]);
    if (bigKeys && bigKeys.length && (bigKeys.includes(fromKey) || bigKeys.includes(toKey))) return;

    const item = v[fromIndex];
    const next = v.filter((_, i) => i !== fromIndex);
    next.splice(toIndex, 0, item);
    applyVisibleOrder(next);
    saveState();
    fullRender();
  }

  /** Stable signature of the current grid — used to skip rebuild when poll didn’t change visibility. */
  function visibleChannelsSignature() {
    const { orderedVisible } = visibleChannelsForLayout();
    return orderedVisible.map((ch) => channelKey(ch)).join('\x1e');
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
    const twitchChat = twitchChannelsForChat();
    if (state.chatForLogin && !twitchChat.includes(state.chatForLogin)) {
      state.chatForLogin = twitchChat[0] || null;
    }
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
    // Update layout immediately if priority mode is enabled.
    if (state.priorityTiles) layoutGridToViewport();
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
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.setAttribute('aria-label', `Remove ${lbl}`);
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.channels = state.channels.filter((c) => channelKey(c) !== key);
        const twitchChat = twitchChannelsForChat();
        if (state.chatForLogin && !twitchChat.includes(state.chatForLogin)) {
          state.chatForLogin = twitchChat[0] || null;
        }
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

  function renderChatSelect() {
    const prev = state.chatForLogin;
    const twitchList = twitchChannelsForChat();
    const selects = [els.chatChannel, els.chatChannelPanel].filter(Boolean);
    for (const sel of selects) {
      sel.innerHTML = '';
      twitchList.forEach((login) => {
        const opt = document.createElement('option');
        opt.value = login;
        opt.textContent = login;
        sel.appendChild(opt);
      });
    }
    if (twitchList.length) {
      if (!twitchList.includes(prev)) state.chatForLogin = twitchList[0];
      const v = state.chatForLogin || twitchList[0];
      state.chatForLogin = v;
      for (const sel of selects) {
        sel.value = v;
      }
    } else {
      state.chatForLogin = null;
    }
  }

  function renderChatIframe() {
    els.chatIframeWrap.innerHTML = '';
    if (!state.showChat || !state.chatForLogin) return;
    if (state.hideChatPanel) return;
    const iframe = document.createElement('iframe');
    iframe.src = chatSrc(state.chatForLogin);
    iframe.title = `Twitch chat: ${state.chatForLogin}`;
    els.chatIframeWrap.appendChild(iframe);
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

    els.grid.querySelectorAll('.cell').forEach((cell) => {
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
    if (!els.grid) return;
    els.grid.querySelectorAll('.cell.cell-drag-over').forEach((el) => {
      el.classList.remove('cell-drag-over');
    });
  }

  function endGridDragListeners() {
    document.removeEventListener('pointermove', onGridPointerMove);
    document.removeEventListener('pointerup', onGridPointerUp);
    document.removeEventListener('pointercancel', onGridPointerUp);
  }

  function onGridPointerMove(e) {
    if (!gridDragState || !els.grid) return;
    clearGridDragOver();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest('.cell');
    if (cell && els.grid.contains(cell)) {
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
    if (targetCell && els.grid.contains(targetCell)) {
      const toIndex = parseInt(targetCell.dataset.cellIndex || '', 10);
      if (!Number.isNaN(toIndex) && fromIndex !== toIndex) {
        reorderVisibleChannelsGrid(fromIndex, toIndex);
      }
    }
    gridDragState = null;
  }

  function onGridPointerDown(e) {
    const handle = e.target && e.target.closest('.cell-drag-handle');
    if (!handle || !els.grid || !els.grid.contains(handle)) return;
    const cell = handle.closest('.cell');
    if (!cell || !els.grid.contains(cell)) return;
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
    if (!els.grid || gridDragBound) return;
    gridDragBound = true;
    els.grid.addEventListener('pointerdown', onGridPointerDown);
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
    video.autoplay = true;

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
          return 'Twitch HLS: could not load playlist (offline stream, or install streamlink + ffmpeg on the server — see server log).';
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
        enableWorker: false,
        ...(twitchHls
          ? {
              maxBufferLength: 45,
              maxMaxBufferLength: 120,
              backBufferLength: 60,
              liveSyncDurationCount: 4,
              liveMaxLatencyDurationCount: 12,
              maxLiveSyncPlaybackRate: 1.5,
            }
          : {}),
      });
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      video._hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) fail(formatHlsFatalError(data));
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playbackUrl;
      video.play().catch(() => {});
    } else {
      fail('HLS not supported in this browser.');
    }

    cell.appendChild(video);
    const lab = document.createElement('div');
    lab.className = 'cell-label';
    lab.textContent = formatChannelLabel(ch);
    cell.appendChild(lab);
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
      if (twitchPlayback === 'hls') {
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

  function renderGrid() {
    disconnectCellObservers();
    const layout = computeGridLayoutVars();
    const visible = layout.orderedVisible;
    const desiredKeys = visible.map(channelKey);
    const n = visible.length;

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

    let cells = Array.from(els.grid.querySelectorAll('.cell'));
    const keysMatch =
      cells.length === desiredKeys.length &&
      desiredKeys.every((k, i) => cells[i]?.dataset?.channelKey === k);

    if (keysMatch) {
      cells.forEach((cell, i) => {
        cell.dataset.cellIndex = String(i);
      });
      applyBigTileCellSpans(layout.bigKeys, layout.spanW, layout.spanH);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => attachCellObserversToGrid());
      });
      return;
    }

    for (let i = 0; i < desiredKeys.length; i++) {
      const wantKey = desiredKeys[i];
      const ch = visible[i];
      const el = els.grid.children[i];
      if (el && el.dataset.channelKey === wantKey) {
        el.dataset.cellIndex = String(i);
        continue;
      }
      const found = Array.from(els.grid.querySelectorAll('.cell')).find(
        (c) => c.dataset.channelKey === wantKey
      );
      if (found) {
        els.grid.insertBefore(found, el || null);
        found.dataset.cellIndex = String(i);
        continue;
      }
      const newCell = buildCellForChannel(ch, i);
      els.grid.insertBefore(newCell, els.grid.children[i] || null);
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

  function applyChatLayout() {
    const hasTwitchChat = twitchChannelsForChat().length > 0;
    els.showChat.checked = state.showChat;
    els.hideOffline.checked = state.hideOffline;
    els.chatChannelWrap.hidden = !state.showChat || !hasTwitchChat;
    if (els.hideChatPanelWrap) {
      els.hideChatPanelWrap.hidden = !state.showChat;
    }
    if (els.chatOnLeftWrap) {
      els.chatOnLeftWrap.hidden = !state.showChat;
    }
    if (els.hideChatPanel) {
      els.hideChatPanel.checked = state.hideChatPanel;
    }
    if (els.chatOnLeft) {
      els.chatOnLeft.checked = state.chatOnLeft;
    }
    const panelVisible =
      state.showChat && hasTwitchChat && !state.hideChatPanel;
    els.chatPanel.hidden = !panelVisible;
    if (els.main) {
      els.main.classList.toggle(
        'chat-on-left',
        Boolean(state.chatOnLeft && state.showChat)
      );
    }
    if (els.app) {
      els.app.classList.toggle(
        'chat-on-left',
        Boolean(state.chatOnLeft && state.showChat)
      );
    }
    if (els.peekChat) {
      els.peekChat.hidden = !(
        state.showChat &&
        state.hideChatPanel &&
        hasTwitchChat
      );
    }
    renderChatIframe();
    requestAnimationFrame(() => layoutGridToViewport());
  }

  function updateRefreshStreamsButton() {
    if (!els.refreshStreams) return;
    const hasTwitchToPoll = twitchLoginsForPoll().length > 0;
    els.refreshStreams.hidden = !hasTwitchToPoll;
    els.refreshStreams.disabled = !hasTwitchToPoll;
  }

  function fullRender() {
    renderChannelChips();
    renderChatSelect();
    applyChatLayout();
    applyToolbarLayout();
    renderGrid();
    updateFollowImportButtonsVisibility();
    updatePriorityEditButtonVisibility();
    updateRefreshStreamsButton();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => layoutGridToViewport());
    });
  }

  async function tick() {
    const before = visibleChannelsSignature();
    await refreshOnline();
    renderChannelChips();
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
    if (!state.chatForLogin && getChannelType(newCh) === 'twitch') {
      state.chatForLogin = getTwitchLogin(newCh);
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

  els.showChat.addEventListener('change', () => {
    state.showChat = els.showChat.checked;
    if (!state.showChat) {
      state.hideChatPanel = false;
    }
    saveState();
    applyChatLayout();
  });

  if (els.hideChatPanel) {
    els.hideChatPanel.addEventListener('change', () => {
      state.hideChatPanel = els.hideChatPanel.checked;
      saveState();
      applyChatLayout();
    });
  }

  if (els.chatOnLeft) {
    els.chatOnLeft.addEventListener('change', () => {
      state.chatOnLeft = els.chatOnLeft.checked;
      saveState();
      applyChatLayout();
    });
  }

  function onChatChannelPick(source) {
    const v = source.value;
    state.chatForLogin = v;
    if (els.chatChannel && source !== els.chatChannel) els.chatChannel.value = v;
    if (els.chatChannelPanel && source !== els.chatChannelPanel) {
      els.chatChannelPanel.value = v;
    }
    saveState();
    renderChatIframe();
  }

  els.chatChannel.addEventListener('change', () => onChatChannelPick(els.chatChannel));
  if (els.chatChannelPanel) {
    els.chatChannelPanel.addEventListener('change', () =>
      onChatChannelPick(els.chatChannelPanel)
    );
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

  els.closeChat.addEventListener('click', () => {
    state.hideChatPanel = true;
    saveState();
    applyChatLayout();
  });

  if (els.peekChat) {
    els.peekChat.addEventListener('click', () => {
      state.hideChatPanel = false;
      saveState();
      applyChatLayout();
    });
  }

  els.hideOffline.checked = state.hideOffline;
  if (els.priorityTiles) {
    els.priorityTiles.checked = state.priorityTiles;
  }
  if (els.priorityEditSelection) {
    els.priorityEditSelection.addEventListener('click', () => {
      openPriorityModal();
    });
  }
  els.showChat.checked = state.showChat;

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
      if (!grid) {
        console.warn('[twitchviewer] No #grid');
        return;
      }
      const cells = grid.querySelectorAll('.cell');
      console.log(
        `[twitchviewer] ${cells.length} grid cell(s). Twitch mode: ${twitchPlayback} (hls = same-origin video via streamlink+ffmpeg; iframe = Twitch embed).`
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
      if (j.twitchPlayback === 'hls' || j.twitchPlayback === 'iframe') {
        twitchPlayback = j.twitchPlayback;
      }
    } catch {
      apiConfigured = false;
    }
    renderChatSelect();
    await ensureTranscodeHashes();
    await refreshOnly();
    await refreshAuth();
    setupGridDrag();
    fullRender();
    schedulePoll();
    console.info(
      `[twitchviewer] Twitch playback: ${twitchPlayback}. With streamlink+ffmpeg on the server, Twitch uses HLS (reliable muted autoplay). Otherwise the official iframe embed is used. Run twitchviewerAutoplayDiagnostics().`
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
