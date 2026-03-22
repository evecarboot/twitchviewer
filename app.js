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
    showChat: document.getElementById('show-chat'),
    chatChannelWrap: document.getElementById('chat-channel-wrap'),
    chatChannel: document.getElementById('chat-channel'),
    toolbarToggle: document.getElementById('toolbar-toggle'),
    toolbar: document.getElementById('toolbar'),
    peekTab: document.getElementById('peek-tab'),
    toolbarMeta: document.getElementById('toolbar-meta'),
    channelList: document.getElementById('channel-list'),
    grid: document.getElementById('grid'),
    chatPanel: document.getElementById('chat-panel'),
    chatIframeWrap: document.getElementById('chat-iframe-wrap'),
    chatPanelTitle: document.getElementById('chat-panel-title'),
    closeChat: document.getElementById('close-chat'),
    offlineBar: document.getElementById('offline-bar'),
    main: document.getElementById('main'),
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
        channels: Array.isArray(parsed.channels) ? parsed.channels : [],
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
    return qs.toString();
  }

  function playerSrc(login) {
    const q = embedParents();
    return `https://player.twitch.tv/?channel=${encodeURIComponent(
      login
    )}&${q}&muted=false`;
  }

  function chatSrc(login) {
    const q = embedParents();
    return `https://www.twitch.tv/embed/${encodeURIComponent(
      login
    )}/chat?${q}&darkpopout`;
  }

  function gridDimensions(count) {
    if (count <= 0) return { cols: 1, rows: 1 };
    if (count === 1) return { cols: 1, rows: 1 };
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
  }

  function visibleLogins() {
    if (!state.hideOffline || !apiConfigured || pollFailed) return [...state.channels];
    return state.channels.filter((c) => onlineSet.has(c));
  }

  async function refreshOnline() {
    if (!state.channels.length) {
      onlineSet = new Set();
      pollFailed = false;
      return;
    }
    try {
      const q = state.channels.join(',');
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
      state.channels.filter((c) => state.importedFollows.includes(c))
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
    const manual = state.channels.filter((c) => !state.importedFollows.includes(c));
    const importing = state.importedFollows.filter((c) => followModalSelection.has(c));
    const kept = state.channels.filter(
      (c) => manual.includes(c) || importing.includes(c)
    );
    const added = importing.filter((c) => !kept.includes(c));
    state.channels = [...kept, ...added];
    if (state.chatForLogin && !state.channels.includes(state.chatForLogin)) {
      state.chatForLogin = state.channels[0] || null;
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
    state.channels.forEach((login, index) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.draggable = true;
      chip.dataset.index = String(index);
      chip.dataset.login = login;
      if (
        state.hideOffline &&
        apiConfigured &&
        !pollFailed &&
        !onlineSet.has(login)
      ) {
        chip.classList.add('offline-badge');
      }
      const label = document.createElement('span');
      label.textContent = login;
      chip.appendChild(label);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.setAttribute('aria-label', `Remove ${login}`);
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.channels = state.channels.filter((c) => c !== login);
        if (state.chatForLogin === login) {
          state.chatForLogin = state.channels[0] || null;
        }
        saveState();
        fullRender();
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
    els.chatChannel.innerHTML = '';
    state.channels.forEach((login) => {
      const opt = document.createElement('option');
      opt.value = login;
      opt.textContent = login;
      els.chatChannel.appendChild(opt);
    });
    if (state.channels.length) {
      if (!state.channels.includes(prev)) state.chatForLogin = state.channels[0];
      els.chatChannel.value = state.chatForLogin || state.channels[0];
      state.chatForLogin = els.chatChannel.value;
    } else {
      state.chatForLogin = null;
    }
  }

  function renderChatIframe() {
    els.chatIframeWrap.innerHTML = '';
    if (!state.showChat || !state.chatForLogin) return;
    const iframe = document.createElement('iframe');
    iframe.src = chatSrc(state.chatForLogin);
    iframe.title = `Twitch chat: ${state.chatForLogin}`;
    els.chatIframeWrap.appendChild(iframe);
    els.chatPanelTitle.textContent = `Chat — ${state.chatForLogin}`;
  }

  function renderGrid() {
    const visible = visibleLogins();
    const n = visible.length;
    const { cols, rows } = gridDimensions(n);
    els.grid.style.setProperty('--cols', String(Math.max(1, cols)));
    els.grid.style.setProperty('--rows', String(Math.max(1, rows)));
    els.grid.classList.toggle('one-col', n === 1);

    els.grid.innerHTML = '';
    visible.forEach((login) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const iframe = document.createElement('iframe');
      iframe.src = playerSrc(login);
      iframe.title = `Twitch: ${login}`;
      iframe.allowFullscreen = true;
      cell.appendChild(iframe);
      const lab = document.createElement('div');
      lab.className = 'cell-label';
      lab.textContent = login;
      cell.appendChild(lab);
      els.grid.appendChild(cell);
    });

    const offline = state.channels.filter((c) => !onlineSet.has(c));
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
    els.showChat.checked = state.showChat;
    els.hideOffline.checked = state.hideOffline;
    els.chatChannelWrap.hidden = !state.showChat || !state.channels.length;
    els.chatPanel.hidden = !state.showChat || !state.channels.length;
    renderChatIframe();
  }

  function fullRender() {
    renderChannelChips();
    renderChatSelect();
    renderGrid();
    applyChatLayout();
    applyToolbarLayout();
    updateFollowImportButtonsVisibility();
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
    if (state.hideOffline && state.channels.length) {
      pollTimer = setInterval(tick, POLL_MS);
    }
  }

  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const login = normalizeLogin(els.channelInput.value);
    if (!login) return;
    if (!state.channels.includes(login)) state.channels.push(login);
    if (!state.chatForLogin) state.chatForLogin = login;
    els.channelInput.value = '';
    saveState();
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

  els.showChat.addEventListener('change', () => {
    state.showChat = els.showChat.checked;
    saveState();
    applyChatLayout();
  });

  els.chatChannel.addEventListener('change', () => {
    state.chatForLogin = els.chatChannel.value;
    saveState();
    renderChatIframe();
  });

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
    state.showChat = false;
    els.showChat.checked = false;
    saveState();
    applyChatLayout();
  });

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
          state.channels.filter((c) => newList.includes(c))
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
    if (state.chatForLogin && state.channels.includes(state.chatForLogin)) {
      els.chatChannel.value = state.chatForLogin;
    }
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
