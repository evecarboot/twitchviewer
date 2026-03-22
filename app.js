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
    showChat: false,
    hideChatPanel: false,
    chatOnLeft: false,
    chatForLogin: null,
    toolbarCollapsed: false,
  });

  let state = loadState();
  let apiConfigured = false;
  let pollFailed = false;
  let onlineSet = new Set();
  let pollTimer = null;
  /** @type {Set<string>} */
  let followModalSelection = new Set();

  const els = {
    addForm: document.getElementById('add-form'),
    channelInput: document.getElementById('channel-input'),
    hideOffline: document.getElementById('hide-offline'),
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
    chatPanel: document.getElementById('chat-panel'),
    chatIframeWrap: document.getElementById('chat-iframe-wrap'),
    chatChannelPanel: document.getElementById('chat-channel-panel'),
    closeChat: document.getElementById('close-chat'),
    offlineBar: document.getElementById('offline-bar'),
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
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        channels: migrateChannels(parsed.channels),
        importedFollows: Array.isArray(parsed.importedFollows)
          ? parsed.importedFollows
          : [],
      };
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
      if (/^https?:\/\//i.test(url)) return { type: 'hls', url };
      return null;
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
    if (t === 'hls') return `h:${ch.url}`;
    return '';
  }

  function formatChannelLabel(ch) {
    const t = getChannelType(ch);
    if (t === 'twitch') return getTwitchLogin(ch);
    if (t === 'youtube') return `YT: ${ch.id}`;
    if (t === 'hls') return `HLS: ${hlsShortLabel(ch.url)}`;
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

  function embedParents() {
    const h = window.location.hostname;
    const qs = new URLSearchParams();
    qs.append('parent', h);
    if (h === '127.0.0.1') qs.append('parent', 'localhost');
    if (h === 'localhost') qs.append('parent', '127.0.0.1');
    return qs;
  }

  function playerSrc(login) {
    const params = embedParents();
    params.set('channel', login);
    params.set('autoplay', 'true');
    params.set('muted', 'true');
    return `https://player.twitch.tv/?${params.toString()}`;
  }

  function chatSrc(login) {
    const params = embedParents();
    return `https://www.twitch.tv/embed/${encodeURIComponent(
      login
    )}/chat?${params.toString()}&darkpopout`;
  }

  function gridDimensions(count) {
    if (count <= 0) return { cols: 1, rows: 1 };
    if (count === 1) return { cols: 1, rows: 1 };
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
  }

  function visibleChannels() {
    return state.channels.filter((ch) => {
      if (getChannelType(ch) !== 'twitch') return true;
      if (!state.hideOffline || !apiConfigured || pollFailed) return true;
      return onlineSet.has(getTwitchLogin(ch));
    });
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

  function destroyGridHls() {
    els.grid.querySelectorAll('video.cell-video').forEach((video) => {
      if (video._hls) {
        video._hls.destroy();
        video._hls = null;
      }
    });
  }

  function renderGrid() {
    destroyGridHls();
    const visible = visibleChannels();
    const n = visible.length;
    const { cols, rows } = gridDimensions(n);
    els.grid.style.setProperty('--cols', String(Math.max(1, cols)));
    els.grid.style.setProperty('--rows', String(Math.max(1, rows)));
    els.grid.classList.toggle('one-col', n === 1);

    els.grid.innerHTML = '';
    visible.forEach((ch) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const t = getChannelType(ch);

      if (t === 'twitch') {
        const login = getTwitchLogin(ch);
        const iframe = document.createElement('iframe');
        iframe.src = playerSrc(login);
        iframe.title = `Twitch: ${login}`;
        iframe.setAttribute('width', '400');
        iframe.setAttribute('height', '300');
        iframe.setAttribute('loading', 'eager');
        iframe.setAttribute(
          'allow',
          'autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write'
        );
        iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        iframe.allowFullscreen = true;
        cell.appendChild(iframe);
        const lab = document.createElement('div');
        lab.className = 'cell-label';
        lab.textContent = login;
        cell.appendChild(lab);
      } else if (t === 'youtube') {
        const iframe = document.createElement('iframe');
        iframe.src = youtubeEmbedSrc(ch.id);
        iframe.title = `YouTube: ${ch.id}`;
        iframe.setAttribute('loading', 'eager');
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
        const video = document.createElement('video');
        video.className = 'cell-video';
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.autoplay = true;
        const url = ch.url;

        const fail = (msg) => {
          if (cell.querySelector('.cell-hls-error')) return;
          const err = document.createElement('div');
          err.className = 'cell-hls-error';
          err.textContent = msg;
          cell.appendChild(err);
        };

        function formatHlsFatalError(data) {
          const details = data && data.details ? String(data.details) : '';
          const typ = data && data.type != null ? String(data.type) : '';
          if (
            details.includes('bufferAppendError') ||
            details.includes('fragParsingError') ||
            details.includes('bufferAddCodecError')
          ) {
            return 'Browser cannot decode this stream (often MPEG-2 or AC3 in .ts). Chrome/Edge usually need H.264/AAC HLS. Try Safari or another m3u8.';
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

        // Prefer MSE + hls.js when available. Some browsers report a truthy
        // canPlayType for application/vnd.apple.mpegurl but cannot play HLS
        // via <video src> (e.g. Chromium), which breaks raw m3u8 URLs.
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: false,
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          video._hls = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) fail(formatHlsFatalError(data));
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
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

      els.grid.appendChild(cell);
    });

    const offline = state.channels
      .filter(
        (c) =>
          getChannelType(c) === 'twitch' && !onlineSet.has(getTwitchLogin(c))
      )
      .map((c) => getTwitchLogin(c));
    if (state.hideOffline && apiConfigured && !pollFailed && offline.length) {
      els.offlineBar.hidden = false;
      els.offlineBar.textContent = `Offline (hidden): ${offline.join(', ')}`;
    } else {
      els.offlineBar.hidden = true;
    }
  }

  function applyToolbarLayout() {
    els.toolbar.classList.toggle('collapsed', state.toolbarCollapsed);
    els.peekTab.hidden = !state.toolbarCollapsed;
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
  }

  function updateRefreshStreamsButton() {
    if (!els.refreshStreams) return;
    const hasAny = state.channels.length > 0;
    els.refreshStreams.hidden = !hasAny;
    els.refreshStreams.disabled = !hasAny;
  }

  function fullRender() {
    renderChannelChips();
    renderChatSelect();
    renderGrid();
    applyChatLayout();
    applyToolbarLayout();
    updateFollowImportButtonsVisibility();
    updateRefreshStreamsButton();
  }

  async function tick() {
    await refreshOnline();
    renderChannelChips();
    renderGrid();
  }

  async function refreshOnly() {
    await refreshOnline();
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (state.hideOffline && twitchLoginsForPoll().length) {
      pollTimer = setInterval(tick, POLL_MS);
    }
  }

  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newCh = parseAddInput(els.channelInput.value);
    if (!newCh) {
      setMeta(
        'Use a Twitch name, YouTube watch/live URL, or m3u8 URL (prefix yt: or hls: optional).',
        true
      );
      return;
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

  if (els.refreshStreams) {
    els.refreshStreams.addEventListener('click', async () => {
      if (!state.channels.length) return;
      els.refreshStreams.disabled = true;
      try {
        await tick();
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !els.followModal || els.followModal.hidden) return;
    closeFollowModal();
  });

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
    } catch {
      apiConfigured = false;
    }
    renderChatSelect();
    await refreshOnly();
    await refreshAuth();
    fullRender();
    schedulePoll();
    if (urlErr) {
      try {
        setMeta(decodeURIComponent(urlErr), true);
      } catch {
        setMeta(urlErr, true);
      }
    }
  })();
})();
