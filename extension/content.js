/**
 * YouTube Translator — content script
 *
 * Инжектируется на все страницы YouTube. Встраивает кнопку-переводчик
 * в нижнюю панель управления плеера. При клике — всплывающая панель
 * с управлением переводом, громкостью и языком.
 */

// ─── Minimal Socket.IO v4 client ─────────────────────────────────────────────

class MinimalSocketIO {
  constructor(url) {
    this.url       = url;
    this.ws        = null;
    this._handlers = {};
  }

  connect() {
    const wsUrl = this.url.replace(/^http/, 'ws') +
      '/socket.io/?EIO=4&transport=websocket';
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[YTT] WebSocket создать не удалось:', e);
      return;
    }

    this.ws.onopen    = () => { this.ws.send('40'); };
    this.ws.onmessage = ({ data }) => {
      if (!data || !data.length) return;
      const eioType = parseInt(data[0], 10);
      if (eioType === 2) { this.ws.send('3'); return; }
      if (eioType === 4) {
        const sioType = parseInt(data[1], 10);
        if (sioType === 0) { this._emit('connect'); return; }
        if (sioType === 2) {
          try {
            const [event, ...args] = JSON.parse(data.slice(2));
            this._emit(event, ...args);
          } catch (e) {
            console.error('[YTT] Parse error:', e, data.slice(0, 80));
          }
        }
      }
    };
    this.ws.onclose = () => { this._emit('disconnect'); };
    this.ws.onerror = (e) => { console.error('[YTT] WS error:', e); };
  }

  on(event, handler)   { this._handlers[event] = handler; return this; }
  off(event)           { delete this._handlers[event]; }
  emit(event, ...args) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN)
      this.ws.send('42' + JSON.stringify([event, ...args]));
  }
  disconnect() { if (this.ws) { this.ws.close(); this.ws = null; } }
  _emit(event, ...args) {
    if (this._handlers[event]) this._handlers[event](...args);
  }
}

// ─── YouTubeTranslator ────────────────────────────────────────────────────────

class YouTubeTranslator {
  constructor() {
    this.socket          = null;
    this.isActive        = false;
    this.video           = null;
    this.overlay         = null;
    this.subtitleEl      = null;
    this.btnEl           = null;
    this.panelEl         = null;
    this.panelOpen       = false;
    this.audioQueue      = [];
    this._currentAudio   = null;
    this._currentSegment = null;
    this.settings        = {};
    this.playbackTimer   = null;
    this._pendingStart   = null;
    this._queueTimer     = null;
    this._origVolume     = 1.0;
    this._transVolume    = 1.0;
    this._btnPosObs      = null;
    this._btnPosTimer    = null;
    this._btnPosResize   = null;
    this._btnInsertTimer = null;
    this._ttsProviders   = null;   // кеш метаданных провайдеров с бэкенда
    this.spinnerEl       = null;
  }

  async init() {
    this.settings = await this._loadSettings();
    this._origVolume  = this.settings.origVolume  ?? 1.0;
    this._transVolume = this.settings.transVolume ?? 1.0;
    await this._waitForPlayer();
    this._injectUI();
    this._watchNavigation();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async _loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get({
        targetLanguage:    'ru',
        backendUrl:        'http://localhost:8211',
        openaiApiKey:      '',
        deepgramApiKey:    '',
        origVolume:        0.1,
        transVolume:       1.0,
        ttsProvider:       'edge-tts',
        ttsProviderConfig: '{}',   // JSON-строка Record<string,string>
        voiceClone:        false,
      }, resolve);
    });
  }

  /** Загружает список TTS-провайдеров с бэкенда (HTTP GET /api/tts-providers) */
  async _loadTTSProviders() {
    try {
      const url = (this.settings.backendUrl || 'http://localhost:8211') + '/api/tts-providers';
      const res  = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data.providers || null;
    } catch {
      return null;
    }
  }

  /** Тестирует соединение с выбранным TTS-провайдером */
  async _testTTSProvider(providerId, cfg) {
    const url = (this.settings.backendUrl || 'http://localhost:8211') + '/api/test-tts';
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ providerId, config: cfg }),
      signal:  AbortSignal.timeout(8000),
    });
    return res.json();
  }

  _saveVolumes() {
    chrome.storage.sync.set({
      origVolume:  this._origVolume,
      transVolume: this._transVolume,
    });
  }

  // ── Player detection ──────────────────────────────────────────────────────

  async _waitForPlayer() {
    return new Promise(resolve => {
      const check = () => {
        const video = document.querySelector('video.html5-main-video')
                   || document.querySelector('video');
        const player = this._isShorts()
          ? (document.querySelector('#shorts-player')
             || document.querySelector('ytd-reel-video-renderer'))
          : document.querySelector('#movie_player');
        if (video && player) {
          this.video = video;
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  // ── Inject UI ─────────────────────────────────────────────────────────────

  _injectUI() {
    if (this._isShorts()) { this._injectUIShorts(); return; }

    const player = document.querySelector('#movie_player');
    if (!player || document.getElementById('ytt-overlay')) return;

    // Корневой overlay (non-interactive, для субтитров и панели)
    const overlay = document.createElement('div');
    overlay.id = 'ytt-overlay';
    overlay.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2000;';

    // Субтитры
    const sub = document.createElement('div');
    sub.id = 'ytt-subtitle';
    sub.style.cssText = `
      position:absolute; bottom:80px; left:50%;
      transform:translateX(-50%);
      background:rgba(0,0,0,0.78); color:#fff;
      font-size:20px; font-family:Arial,sans-serif; font-weight:500;
      padding:7px 18px; border-radius:5px; max-width:78%;
      text-align:center; line-height:1.45; display:none;
      text-shadow:0 1px 3px rgba(0,0,0,0.8);
    `;

    // Спиннер-индикатор стадии обработки
    const spinner = document.createElement('div');
    spinner.id = 'ytt-spinner';
    spinner.style.cssText = `
      position:absolute; bottom:80px; left:50%;
      transform:translateX(-50%);
      background:rgba(0,0,0,0.82); color:#fff;
      font-size:15px; font-family:Arial,sans-serif; font-weight:500;
      padding:8px 22px; border-radius:8px;
      display:none; align-items:center; gap:10px;
      text-shadow:0 1px 3px rgba(0,0,0,0.8);
      z-index:2001;
    `;
    spinner.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" style="animation:ytt-spin 0.8s linear infinite;flex-shrink:0">
        <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>
        <path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <span id="ytt-spinner-text">Подключение…</span>
    `;

    // CSS-анимация спиннера
    if (!document.getElementById('ytt-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'ytt-spinner-style';
      style.textContent = '@keyframes ytt-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }

    overlay.appendChild(sub);
    overlay.appendChild(spinner);
    player.appendChild(overlay);

    this.overlay    = overlay;
    this.subtitleEl = sub;
    this.spinnerEl  = spinner;

    // Кнопка — вставляем в правую часть controls bar YouTube
    this._injectButton(player);

    // Всплывающая панель
    this._injectPanel(player);

    // Слушатели video
    if (this.video) {
      this.video.addEventListener('seeking', () => {
        if (!this.isActive || !this.socket) return;
        this.socket.emit('seek', { time: this.video.currentTime });
        this._clearAudio();
      });

      // Пауза видео → останавливаем TTS и планировщик
      this.video.addEventListener('pause', () => {
        if (!this.isActive) return;
        if (this._currentAudio) {
          this._currentAudio.pause();
        }
        this._stopQueueScheduler();
      });

      // Возобновление видео → продолжаем TTS и планировщик
      this.video.addEventListener('play', () => {
        if (!this.isActive) return;
        if (this._currentAudio) {
          this._currentAudio.play().catch(() => {});
        }
        this._startQueueScheduler();
      });

      this.video.addEventListener('ratechange', () => {
        this._onVideoRateChange(this.video.playbackRate);
      });
    }

    // Закрытие панели по клику вне
    document.addEventListener('click', (e) => {
      if (this.panelOpen &&
          !this.panelEl?.contains(e.target) &&
          e.target !== this.btnEl &&
          !this.btnEl?.contains(e.target)) {
        this._closePanel();
      }
    }, true);
  }

  // ── Shorts UI ─────────────────────────────────────────────────────────────

  _injectUIShorts() {
    if (document.getElementById('ytt-overlay')) return;

    // Overlay и субтитры — фиксированные поверх страницы
    const overlay = document.createElement('div');
    overlay.id = 'ytt-overlay';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;';

    const sub = document.createElement('div');
    sub.id = 'ytt-subtitle';
    sub.style.cssText = `
      position:absolute; bottom:100px; left:50%;
      transform:translateX(-50%);
      background:rgba(0,0,0,0.78); color:#fff;
      font-size:18px; font-family:Arial,sans-serif; font-weight:500;
      padding:6px 16px; border-radius:5px; max-width:80%;
      text-align:center; line-height:1.45; display:none;
    `;
    // Спиннер-индикатор стадии обработки (Shorts)
    const spinner = document.createElement('div');
    spinner.id = 'ytt-spinner';
    spinner.style.cssText = `
      position:absolute; bottom:100px; left:50%;
      transform:translateX(-50%);
      background:rgba(0,0,0,0.82); color:#fff;
      font-size:14px; font-family:Arial,sans-serif; font-weight:500;
      padding:7px 18px; border-radius:8px;
      display:none; align-items:center; gap:10px;
      z-index:2001;
    `;
    spinner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" style="animation:ytt-spin 0.8s linear infinite;flex-shrink:0">
        <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>
        <path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <span id="ytt-spinner-text">Подключение…</span>
    `;

    overlay.appendChild(sub);
    overlay.appendChild(spinner);
    document.body.appendChild(overlay);

    this.overlay    = overlay;
    this.subtitleEl = sub;
    this.spinnerEl  = spinner;

    // Кнопка в панели действий Shorts (правая сторона)
    this._injectButtonShorts();

    // Всплывающая панель
    this._injectPanel(document.body, true);

    // Слушатели видео
    if (this.video) {
      this.video.addEventListener('pause', () => {
        if (!this.isActive) return;
        if (this._currentAudio) this._currentAudio.pause();
        this._stopQueueScheduler();
      });
      this.video.addEventListener('play', () => {
        if (!this.isActive) return;
        if (this._currentAudio) this._currentAudio.play().catch(() => {});
        this._startQueueScheduler();
      });
      this.video.addEventListener('seeking', () => {
        if (!this.isActive || !this.socket) return;
        this.socket.emit('seek', { time: this.video.currentTime });
        this._clearAudio();
      });
      this.video.addEventListener('ratechange', () => {
        this._onVideoRateChange(this.video.playbackRate);
      });
    }

    // Закрытие панели по клику вне
    document.addEventListener('click', (e) => {
      if (this.panelOpen &&
          !this.panelEl?.contains(e.target) &&
          e.target !== this.btnEl &&
          !this.btnEl?.contains(e.target)) {
        this._closePanel();
      }
    }, true);
  }

  _injectButtonShorts() {
    // Пробуем вставить сразу; если DOM плеера ещё не готов — повторяем раз в 300 мс
    if (!this._insertBtnBetweenControls()) {
      this._btnInsertTimer = setInterval(() => {
        if (this._insertBtnBetweenControls()) {
          clearInterval(this._btnInsertTimer);
          this._btnInsertTimer = null;
          this._watchBtnPresence();
        }
      }, 300);
    } else {
      this._watchBtnPresence();
    }
  }

  // Создаёт нашу кнопку и вставляет её прямо в DOM плеера между play и mute.
  // Возвращает true при успехе.
  _insertBtnBetweenControls() {
    const player = document.querySelector('#shorts-player');
    if (!player) return false;

    // Кнопка play — якорь для вставки
    const playBtn = player.querySelector('.ytp-play-button');
    if (!playBtn || !playBtn.parentNode) return false;

    // Не дублируем
    if (document.getElementById('ytt-btn')) return true;

    const btn = document.createElement('button');
    btn.id    = 'ytt-btn';
    btn.title = 'YouTube Translator';
    // Стиль под нативные кнопки YT Shorts: round, same dark-bg, inline-flex
    btn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:48px;height:48px;min-width:48px;border-radius:50%;padding:0;' +
      'background:rgba(0,0,0,0.5);border:none;cursor:pointer;vertical-align:middle;' +
      'opacity:0.95;transition:opacity 0.15s,transform 0.15s;flex-shrink:0;' +
      'margin:0 2px;';
    btn.innerHTML = this._svgLogo('idle');
    btn.addEventListener('mouseenter', () => { btn.style.opacity='1'; btn.style.transform='scale(1.1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity='0.95'; btn.style.transform='scale(1)'; });
    btn.addEventListener('click', e => { e.stopPropagation(); this._togglePanel(); });
    this.btnEl = btn;

    // Вставляем после play, перед mute (если mute в том же контейнере)
    const muteBtn = playBtn.parentNode.querySelector('.ytp-mute-button');
    if (muteBtn && muteBtn !== playBtn.nextSibling) {
      playBtn.parentNode.insertBefore(btn, muteBtn);
    } else {
      playBtn.insertAdjacentElement('afterend', btn);
    }

    return true;
  }

  // Следит, что наша кнопка не исчезла из DOM (YT может перестраивать controls).
  // Если пропала — вставляет снова.
  _watchBtnPresence() {
    this._btnPosTimer = setInterval(() => {
      const existing = document.getElementById('ytt-btn');
      if (!existing) {
        // Кнопку выбросило — пересоздаём
        this.btnEl = null;
        this._insertBtnBetweenControls();
      } else {
        // Синхронизируем ссылку
        this.btnEl = existing;
      }
    }, 1000);
  }

  _injectButton(player) {
    const btn = document.createElement('button');
    btn.id    = 'ytt-btn';
    btn.title = 'YouTube Translator';
    // Inline !important бьёт любые внешние правила (class-based CSS YouTube не может победить)
    btn.style.cssText =
      'width:36px !important;height:36px !important;' +
      'min-width:36px !important;min-height:36px !important;' +
      'display:inline-flex !important;align-items:center !important;' +
      'justify-content:center !important;flex-shrink:0 !important;' +
      'padding:0 !important;border:none !important;background:transparent !important;' +
      'cursor:pointer;opacity:0.9;transition:opacity 0.15s;';

    btn.innerHTML = this._svgLogo('idle');
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.9'; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._togglePanel(); });

    this.btnEl = btn;

    // Вставляем в flex-контейнер controls bar с ретраями (YouTube рендерит асинхронно)
    this._tryInsertBtn(btn, player, 0);

    // MutationObserver: если YouTube перерендерит controls и удалит нашу кнопку — вставим снова
    this._watchBtnEviction(btn, player);
  }

  _tryInsertBtn(btn, player, attempt) {
    if (btn.isConnected) return;
    if (attempt > 20) return; // ~6 секунд

    const settingsBtn = player.querySelector('.ytp-settings-button');
    if (settingsBtn?.parentNode) {
      try {
        settingsBtn.parentNode.insertBefore(btn, settingsBtn);
        if (btn.isConnected) return; // успех
      } catch {}
    }
    setTimeout(() => this._tryInsertBtn(btn, player, attempt + 1), 300);
  }

  _watchBtnEviction(btn, player) {
    // Наблюдаем за controls bar: если наша кнопка пропала — вставляем снова
    const target = player.querySelector('.ytp-right-controls') || player;
    this._btnPosObs = new MutationObserver(() => {
      if (!btn.isConnected) {
        this._tryInsertBtn(btn, player, 0);
      }
    });
    this._btnPosObs.observe(target, { childList: true, subtree: true });
  }

  _stopBtnTracking() {
    if (this._btnPosObs)     { this._btnPosObs.disconnect(); this._btnPosObs = null; }
    if (this._btnPosTimer)   { clearInterval(this._btnPosTimer); this._btnPosTimer = null; }
    if (this._btnInsertTimer){ clearInterval(this._btnInsertTimer); this._btnInsertTimer = null; }
    if (this._btnPosResize)  {
      window.removeEventListener('resize', this._btnPosResize);
      this._btnPosResize = null;
    }
  }

  _svgLogo(state) {
    const isActive      = state === 'active';
    const isConnecting  = state === 'connecting';
    const strokeL       = 'white';
    const strokeR       = isActive ? '#ff6666' : isConnecting ? '#e6a800' : '#ffffff';
    const fillBubble    = isActive ? 'rgba(200,30,30,0.82)' : 'rgba(0,0,0,0.6)';
    const textColorL    = isActive ? '#fff' : 'white';
    const textColorR    = isActive ? '#fff' : (isConnecting ? '#e6a800' : '#aad4ff');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -1 54 44" width="38" height="33" style="margin-top:5px">
      <!-- Правый пузырь (за левым), хвост вправо-вниз -->
      <path d="M18,11 H40 Q44,11 44,15 V26 Q44,30 40,30 H34 L40,36 L36,30 H18 Q14,30 14,26 V15 Q14,11 18,11 Z"
            fill="${fillBubble}" stroke="${strokeR}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="29" y="25" font-family="Arial,sans-serif" font-size="12"
            fill="${textColorR}" text-anchor="middle">文</text>
      <!-- Левый пузырь (поверх), хвост влево-вниз -->
      <path d="M3,1 H24 Q28,1 28,5 V16 Q28,20 24,20 H11 L5,26 L9,20 H3 Q-1,20 -1,16 V5 Q-1,1 3,1 Z"
            fill="${fillBubble}" stroke="${strokeL}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="13" y="15" font-family="Arial,sans-serif" font-size="12" font-weight="bold"
            fill="${textColorL}" text-anchor="middle">A</text>
    </svg>`;
  }

  _injectPanel(player, isShorts = false) {
    const panel = document.createElement('div');
    panel.id = 'ytt-panel';
    panel.style.cssText = `
      display:none;
      ${isShorts ? 'position:fixed; bottom:80px; right:70px;' : 'position:absolute; bottom:56px; right:8px;'}
      width:280px;
      background:rgba(15,15,25,0.92);
      backdrop-filter:blur(12px);
      -webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,0.12);
      border-radius:12px;
      padding:16px;
      z-index:2100;
      pointer-events:all;
      color:#e8e8e8;
      font-family:-apple-system,"Segoe UI",Arial,sans-serif;
      font-size:13px;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);
      animation:ytt-fade-in 0.15s ease;
    `;

    // CSS анимация
    if (!document.getElementById('ytt-style')) {
      const style = document.createElement('style');
      style.id = 'ytt-style';
      style.textContent = `
        @keyframes ytt-fade-in {
          from { opacity:0; transform:translateY(6px); }
          to   { opacity:1; transform:translateY(0); }
        }
        #ytt-btn svg { display:block; }
        #ytt-panel input[type=range] {
          -webkit-appearance:none; appearance:none;
          width:100%; height:4px; border-radius:2px;
          background:rgba(255,255,255,0.15); outline:none; cursor:pointer;
        }
        #ytt-panel input[type=range]::-webkit-slider-thumb {
          -webkit-appearance:none; width:14px; height:14px;
          border-radius:50%; background:#4fc3f7; cursor:pointer;
        }
        #ytt-panel select {
          width:100%; padding:6px 8px; border-radius:6px;
          border:1px solid rgba(255,255,255,0.15);
          background:rgba(255,255,255,0.08); color:#e8e8e8;
          font-size:13px; outline:none; cursor:pointer;
        }
        #ytt-panel select option { background:#1a1a2e; }
        #ytt-toggle-row {
          display:flex; align-items:center; justify-content:space-between;
        }
        #ytt-toggle-label { font-size:14px; font-weight:600; color:#fff; }
        #ytt-toggle-switch {
          width:44px; height:24px; border-radius:12px;
          background:rgba(255,255,255,0.15); border:none;
          cursor:pointer; position:relative; transition:background 0.2s;
          flex-shrink:0;
        }
        #ytt-toggle-switch::after {
          content:''; position:absolute; top:3px; left:3px;
          width:18px; height:18px; border-radius:50%; background:#fff;
          transition:transform 0.2s;
        }
        #ytt-toggle-switch.active { background:#e53e3e; }
        #ytt-toggle-switch.active::after { transform:translateX(20px); }
        #ytt-toggle-switch.connecting { background:#e6a800; }
        /* Кнопка в Shorts */
        #ytt-btn:hover svg { opacity:1; }
        #ytt-btn svg { opacity:0.9; }
        .ytt-vol-row {
          margin-top:10px;
        }
        .ytt-vol-label {
          display:flex; justify-content:space-between;
          margin-bottom:5px; color:rgba(255,255,255,0.6); font-size:11px;
        }
        .ytt-vol-label span { color:#e8e8e8; font-weight:600; }
        .ytt-lang-row { margin-top:14px; }
        .ytt-lang-row label {
          display:block; color:rgba(255,255,255,0.6); font-size:11px;
          margin-bottom:5px;
        }
        #ytt-tts-fields input[type=text],
        #ytt-tts-fields input[type=password] {
          width:100%; box-sizing:border-box; padding:5px 8px; border-radius:6px;
          border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.07);
          color:#e8e8e8; font-size:12px; outline:none;
        }
        #ytt-tts-fields input:focus {
          border-color:rgba(79,195,247,0.5);
        }
        #ytt-tts-test { transition:background 0.15s; }
        #ytt-tts-test:hover { background:rgba(255,255,255,0.1) !important; }
        #ytt-tts-test:disabled { opacity:0.5; cursor:not-allowed; }
      `;
      document.head.appendChild(style);
    }

    panel.innerHTML = `
      <div class="ytt-lang-row" style="margin-top:0; margin-bottom:14px;">
        <label>Язык перевода</label>
        <select id="ytt-lang-select">
          <option value="ru">🇷🇺 Русский</option>
          <option value="en">🇬🇧 English</option>
          <option value="zh">🇨🇳 中文</option>
          <option value="de">🇩🇪 Deutsch</option>
          <option value="fr">🇫🇷 Français</option>
          <option value="es">🇪🇸 Español</option>
          <option value="ja">🇯🇵 日本語</option>
          <option value="ko">🇰🇷 한국어</option>
        </select>
      </div>

      <div class="ytt-lang-row" style="margin-bottom:0;">
        <label>Синтез речи (TTS)</label>
        <select id="ytt-tts-select">
          <option value="edge-tts">Edge TTS (бесплатный)</option>
        </select>
        <div id="ytt-tts-desc" style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.45);line-height:1.4;"></div>
      </div>

      <div id="ytt-tts-fields" style="margin-top:8px;"></div>

      <div id="ytt-voice-clone-row" style="display:none;margin-top:8px;align-items:center;gap:8px;">
        <input type="checkbox" id="ytt-voice-clone" style="width:16px;height:16px;cursor:pointer;">
        <label for="ytt-voice-clone" style="font-size:12px;color:rgba(255,255,255,0.75);cursor:pointer;margin:0;">
          Клонировать голос из видео
        </label>
      </div>

      <div id="ytt-tts-test-row" style="margin-top:8px;display:none;">
        <button id="ytt-tts-test"
          style="width:100%;padding:5px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.2);
                 background:rgba(255,255,255,0.06);color:#e8e8e8;font-size:12px;cursor:pointer;">
          Проверить соединение
        </button>
        <div id="ytt-tts-test-result" style="margin-top:4px;font-size:11px;text-align:center;min-height:14px;"></div>
      </div>

      <div class="ytt-vol-row" style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);">
        <div class="ytt-vol-label">
          Громкость оригинала <span id="ytt-orig-val">${Math.round(this._origVolume * 100)}%</span>
        </div>
        <input type="range" id="ytt-orig-vol" min="0" max="100"
               value="${Math.round(this._origVolume * 100)}">
      </div>

      <div class="ytt-vol-row">
        <div class="ytt-vol-label">
          Громкость перевода <span id="ytt-trans-val">${Math.round(this._transVolume * 100)}%</span>
        </div>
        <input type="range" id="ytt-trans-vol" min="0" max="100"
               value="${Math.round(this._transVolume * 100)}">
      </div>

      <div id="ytt-toggle-row" style="margin-top:14px; margin-bottom:0; padding-top:12px; border-top:1px solid rgba(255,255,255,0.08);">
        <span id="ytt-toggle-label">Перевод выключен</span>
        <button id="ytt-toggle-switch" title="Включить/выключить перевод"></button>
      </div>
    `;

    panel.addEventListener('click', e => e.stopPropagation());
    // В Shorts панель крепится к body (overlay position:fixed, panel position:fixed)
    (isShorts ? document.body : this.overlay).appendChild(panel);
    this.panelEl = panel;

    // Ждём монтирования DOM и навешиваем обработчики
    requestAnimationFrame(() => this._bindPanelEvents());
  }

  _bindPanelEvents() {
    const p = this.panelEl;
    if (!p) return;

    // ── Тогл вкл/выкл ──────────────────────────────────────────────────────
    const toggleBtn = p.querySelector('#ytt-toggle-switch');
    if (toggleBtn) toggleBtn.addEventListener('click', () => this._toggle());

    // ── Громкость оригинала ─────────────────────────────────────────────────
    const origSlider = p.querySelector('#ytt-orig-vol');
    const origVal    = p.querySelector('#ytt-orig-val');
    if (origSlider) {
      origSlider.value = Math.round(this._origVolume * 100);
      origSlider.addEventListener('input', () => {
        const v = origSlider.value / 100;
        this._origVolume = v;
        if (origVal) origVal.textContent = `${origSlider.value}%`;
        if (this.video) this.video.volume = v;
        this._saveVolumes();
      });
    }

    // ── Громкость перевода ──────────────────────────────────────────────────
    const transSlider = p.querySelector('#ytt-trans-vol');
    const transVal    = p.querySelector('#ytt-trans-val');
    if (transSlider) {
      transSlider.value = Math.round(this._transVolume * 100);
      transSlider.addEventListener('input', () => {
        const v = transSlider.value / 100;
        this._transVolume = v;
        if (transVal) transVal.textContent = `${transSlider.value}%`;
        if (this._currentAudio) this._currentAudio.volume = v;
        this._saveVolumes();
      });
    }

    // ── Язык перевода ───────────────────────────────────────────────────────
    const langSelect = p.querySelector('#ytt-lang-select');
    if (langSelect) {
      langSelect.value = this.settings.targetLanguage || 'ru';
      langSelect.addEventListener('change', () => {
        this.settings.targetLanguage = langSelect.value;
        chrome.storage.sync.set({ targetLanguage: langSelect.value });
        if (this.isActive) {
          this._stopTranslation();
          setTimeout(() => this._startTranslation(), 300);
        }
      });
    }

    // ── TTS провайдер ───────────────────────────────────────────────────────
    this._initTTSPanel(p);
  }

  /** Загружает список провайдеров с бэкенда и строит TTS-секцию панели */
  async _initTTSPanel(p) {
    const ttsSelect      = p.querySelector('#ytt-tts-select');
    const ttsFields      = p.querySelector('#ytt-tts-fields');
    const ttsDesc        = p.querySelector('#ytt-tts-desc');
    const testRow        = p.querySelector('#ytt-tts-test-row');
    const testBtn        = p.querySelector('#ytt-tts-test');
    const testResult     = p.querySelector('#ytt-tts-test-result');
    const cloneRow       = p.querySelector('#ytt-voice-clone-row');
    const cloneCheck     = p.querySelector('#ytt-voice-clone');
    if (!ttsSelect) return;

    // Загружаем провайдеры с бэкенда
    const providers = await this._loadTTSProviders();
    this._ttsProviders = providers; // кешируем

    if (providers && providers.length > 0) {
      ttsSelect.innerHTML = providers.map(pr =>
        `<option value="${pr.id}">${pr.name}</option>`
      ).join('');
    }

    // Восстанавливаем сохранённый выбор
    const savedProvider = this.settings.ttsProvider || 'edge-tts';
    ttsSelect.value = savedProvider;

    // Рендерим поля под выбранный провайдер
    const renderProvider = (providerId) => {
      const meta = (this._ttsProviders || []).find(pr => pr.id === providerId);
      if (!meta) { ttsDesc.textContent = ''; ttsFields.innerHTML = ''; return; }

      ttsDesc.textContent = meta.description || '';

      // Показываем / скрываем строку "Клонировать голос"
      cloneRow.style.display = meta.supportsVoiceClone ? 'flex' : 'none';

      // Показываем / скрываем кнопку "Проверить" (не нужна для edge-tts)
      testRow.style.display = meta.fields.length > 0 || meta.id === 'cosyvoice' ? 'block' : 'none';

      // Рендерим поля (apiKey, serverUrl, …)
      let savedCfg = {};
      try { savedCfg = JSON.parse(this.settings.ttsProviderConfig || '{}'); } catch {}

      ttsFields.innerHTML = meta.fields.map(f => {
        if (f.type === 'select') {
          const saved = savedCfg[f.key] || '';
          return `
            <div style="margin-bottom:8px;">
              <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:4px;">${f.label}</div>
              <select
                id="ytt-tts-field-${f.key}"
                style="width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;
                       border:1px solid rgba(255,255,255,0.15);background:rgba(15,15,25,0.95);
                       color:#e8e8e8;font-size:12px;outline:none;"
              >
                <option value="">${f.placeholder || 'Выберите…'}</option>
                ${saved ? `<option value="${saved}" selected>${saved}</option>` : ''}
              </select>
            </div>
          `;
        }
        return `
          <div style="margin-bottom:8px;">
            <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:4px;">${f.label}</div>
            <input
              id="ytt-tts-field-${f.key}"
              type="${f.type === 'password' ? 'password' : 'text'}"
              placeholder="${f.placeholder || ''}"
              value="${(savedCfg[f.key] || '').replace(/"/g, '&quot;')}"
              style="width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;
                     border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);
                     color:#e8e8e8;font-size:12px;outline:none;"
            >
          </div>
        `;
      }).join('');

      // Навешиваем сохранение при изменении полей
      meta.fields.forEach(f => {
        const el = ttsFields.querySelector(`#ytt-tts-field-${f.key}`);
        if (!el) return;
        el.addEventListener(f.type === 'select' ? 'change' : 'input', () => this._saveTTSConfig(providerId));
      });

      // Загружаем опции для select-полей
      meta.fields.filter(f => f.type === 'select' && f.optionsUrl).forEach(f => {
        this._loadSelectOptions(f, providerId, savedCfg);
      });
    };

    renderProvider(savedProvider);

    // При смене провайдера
    ttsSelect.addEventListener('change', () => {
      const id = ttsSelect.value;
      this.settings.ttsProvider = id;
      chrome.storage.sync.set({ ttsProvider: id });
      renderProvider(id);
      testResult.textContent = '';
      if (this.isActive) {
        this._stopTranslation();
        setTimeout(() => this._startTranslation(), 300);
      }
    });

    // Чекбокс клонирования голоса
    if (cloneCheck) {
      cloneCheck.checked = !!this.settings.voiceClone;
      cloneCheck.addEventListener('change', () => {
        this.settings.voiceClone = cloneCheck.checked;
        chrome.storage.sync.set({ voiceClone: cloneCheck.checked });
      });
    }

    // Кнопка "Проверить соединение"
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const providerId = ttsSelect.value;
        const cfg = this._readTTSFields(providerId);
        testBtn.disabled = true;
        testResult.style.color = 'rgba(255,255,255,0.5)';
        testResult.textContent = 'Проверяю…';
        try {
          const res = await this._testTTSProvider(providerId, cfg);
          testResult.style.color = res.ok ? '#4ade80' : '#f87171';
          testResult.textContent  = res.ok ? `✓ ${res.message}` : `✗ ${res.message}`;
        } catch (e) {
          testResult.style.color = '#f87171';
          testResult.textContent = `✗ Нет связи с бэкендом`;
        }
        testBtn.disabled = false;
      });
    }
  }

  /** Читает текущие значения полей TTS из DOM */
  _readTTSFields(providerId) {
    const cfg = {};
    const meta = (this._ttsProviders || []).find(pr => pr.id === providerId);
    if (!meta) return cfg;
    meta.fields.forEach(f => {
      const input = this.panelEl?.querySelector(`#ytt-tts-field-${f.key}`);
      if (input) cfg[f.key] = input.value.trim();
    });
    return cfg;
  }

  /** Сохраняет конфигурацию TTS-провайдера в chrome.storage */
  _saveTTSConfig(providerId) {
    const cfg = this._readTTSFields(providerId);
    this.settings.ttsProviderConfig = JSON.stringify(cfg);
    chrome.storage.sync.set({ ttsProviderConfig: JSON.stringify(cfg) });
  }

  /** Загружает опции для select-поля с бэкенда */
  async _loadSelectOptions(fieldDef, providerId, savedCfg) {
    const selectEl = this.panelEl?.querySelector(`#ytt-tts-field-${fieldDef.key}`);
    if (!selectEl) return;

    // Получаем API key из соседнего поля
    const apiKeyField = fieldDef.optionsApiKeyField;
    const apiKey = apiKeyField
      ? (this.panelEl?.querySelector(`#ytt-tts-field-${apiKeyField}`)?.value || savedCfg[apiKeyField] || '')
      : '';

    if (!apiKey) {
      selectEl.innerHTML = '<option value="">Сначала введите API ключ</option>';
      // Перезагружаем опции когда введут ключ
      const keyInput = this.panelEl?.querySelector(`#ytt-tts-field-${apiKeyField}`);
      if (keyInput) {
        const handler = () => {
          keyInput.removeEventListener('change', handler);
          keyInput.removeEventListener('blur', handler);
          this._loadSelectOptions(fieldDef, providerId, this._readTTSFields(providerId));
        };
        keyInput.addEventListener('change', handler);
        keyInput.addEventListener('blur', handler);
      }
      return;
    }

    selectEl.innerHTML = '<option value="">Загрузка…</option>';
    selectEl.disabled = true;

    try {
      const url = (this.settings.backendUrl || 'http://localhost:8211') + fieldDef.optionsUrl;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const options = await res.json();

      const savedValue = savedCfg[fieldDef.key] || '';
      selectEl.innerHTML = '<option value="">Выберите голос…</option>' +
        options.map(o => `<option value="${o.value}" ${o.value === savedValue ? 'selected' : ''}>${o.label}</option>`).join('');
    } catch (e) {
      selectEl.innerHTML = '<option value="">Ошибка загрузки</option>';
      console.error('[YTT] Ошибка загрузки опций:', e);
    } finally {
      selectEl.disabled = false;
    }
  }

  _togglePanel() {
    if (this.panelOpen) {
      this._closePanel();
    } else {
      this._openPanel();
    }
  }

  _openPanel() {
    if (!this.panelEl) return;
    this.panelEl.style.display = 'block';
    this.panelOpen = true;

    // В Shorts панель position:fixed — позиционируем под кнопкой
    if (this._isShorts() && this.btnEl) {
      const r = this.btnEl.getBoundingClientRect();
      this.panelEl.style.bottom = '';
      this.panelEl.style.top    = Math.round(r.bottom + 8) + 'px';
      this.panelEl.style.right  = '';
      this.panelEl.style.left   = Math.max(4, r.left) + 'px';
    }

    // Обновляем значения слайдеров на случай если изменились
    const origSlider = this.panelEl.querySelector('#ytt-orig-vol');
    const origVal    = this.panelEl.querySelector('#ytt-orig-val');
    const transSlider = this.panelEl.querySelector('#ytt-trans-vol');
    const transVal    = this.panelEl.querySelector('#ytt-trans-val');
    if (origSlider)  origSlider.value  = Math.round(this._origVolume * 100);
    if (origVal)     origVal.textContent = `${Math.round(this._origVolume * 100)}%`;
    if (transSlider) transSlider.value = Math.round(this._transVolume * 100);
    if (transVal)    transVal.textContent = `${Math.round(this._transVolume * 100)}%`;
    const langSelect = this.panelEl.querySelector('#ytt-lang-select');
    if (langSelect)  langSelect.value = this.settings.targetLanguage || 'ru';
  }

  _closePanel() {
    if (!this.panelEl) return;
    this.panelEl.style.display = 'none';
    this.panelOpen = false;
  }

  // ── SPA navigation ────────────────────────────────────────────────────────

  _watchNavigation() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(async () => {
          if (this.isActive) this._stopTranslation();
          this._stopBtnTracking();
          this.overlay?.remove();
          // В Shorts кнопка и панель крепятся к document.body
          document.getElementById('ytt-btn')?.remove();
          document.getElementById('ytt-panel')?.remove();
          document.getElementById('ytt-style')?.remove();
          this.overlay = this.subtitleEl = this.btnEl = this.panelEl = null;
          this.settings = await this._loadSettings();
          await this._waitForPlayer();
          this._injectUI();
        }, 1500);
      }
    }, 1000);
  }

  // ── Toggle ────────────────────────────────────────────────────────────────

  _toggle() {
    if (this.isActive) {
      this._stopTranslation();
    } else {
      this._startTranslation();
    }
  }

  _startTranslation() {
    const videoId = this._getVideoId();
    if (!videoId) return;

    // Немедленно ставим видео на паузу — ждём первого синтезированного чанка
    this.video?.pause();
    this._setStatus('connecting');

    const socket = new MinimalSocketIO(this.settings.backendUrl);

    socket.on('connect', () => {
      if (!this._pendingStart) return;
      socket.emit('start', this._pendingStart);
      this._pendingStart = null;
    });

    socket.on('segment',      (s) => this._handleSegment(s));
    socket.on('pause_video',  ()  => {
      this.video?.pause();
      this._showSpinner('Подготовка…');
    });
    socket.on('resume_video', ()  => {
      this.video?.play().catch(() => {});
      this._setStatus('active');
      this._hideSpinner();
      this._startQueueScheduler();
    });
    socket.on('status',       (d) => {
      // Показываем спиннер только пока видео на паузе (ожидание первого сегмента)
      if (this.video && this.video.paused) {
        this._showSpinner(d.message);
      }
    });
    socket.on('error',        (d) => {
      console.error('[YTT] Server error:', d.message);
      this._hideSpinner();
    });
    socket.on('disconnect',   ()  => {
      if (this.isActive) { this.isActive = false; this._setStatus('idle'); }
    });

    this.socket   = socket;
    this.isActive = true;

    const currentTime = this.video?.currentTime ?? 0;
    let ttsProviderConfig = {};
    try { ttsProviderConfig = JSON.parse(this.settings.ttsProviderConfig || '{}'); } catch {}

    this._pendingStart = {
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      settings: {
        targetLanguage:      this.settings.targetLanguage    || 'ru',
        sttProvider:         'deepgram',
        translationProvider: 'openai',
        ttsProvider:         this.settings.ttsProvider       || 'edge-tts',
        ttsProviderConfig,
        voiceClone:          !!this.settings.voiceClone,
        translationMode:     'streaming',
        preferSubtitles:     true,
        seekTime:            currentTime > 1 ? currentTime : undefined,
        apiKeys: {
          deepgram: this.settings.deepgramApiKey || undefined,
          openai:   this.settings.openaiApiKey   || undefined,
        },
      },
    };

    socket.connect();
    this._startTimer();

    // Применяем громкость оригинала
    if (this.video) this.video.volume = this._origVolume;
  }

  _stopTranslation() {
    this.socket?.emit('stop');
    this.socket?.disconnect();
    this.socket   = null;
    this.isActive = false;
    this._stopTimer();
    this._stopQueueScheduler();
    this._clearAudio();
    this._setSubtitle('');
    this._setStatus('idle');
  }

  // ── Playback timer ────────────────────────────────────────────────────────

  _startTimer() {
    this.playbackTimer = setInterval(() => {
      if (this.socket && this.video)
        this.socket.emit('playback_time', { time: this.video.currentTime });
    }, 1000);
  }

  _stopTimer() {
    clearInterval(this.playbackTimer);
    this.playbackTimer = null;
  }

  // ── Audio queue (time-locked scheduler) ─────────────────────────────────
  //
  // Принцип: каждый сегмент привязан к video.currentTime.
  // Когда видео доходит до segment.startTime — начинаем воспроизведение.
  // TTS ускоряется/замедляется ровно до audioDuration/segmentDuration,
  // чтобы уложиться в окно оригинала.
  // Если следующий сегмент наступил, а предыдущий ещё играет — прерываем.

  _handleSegment(segment) {
    if (segment.audioBase64) {
      this.audioQueue.push(segment);
      this.audioQueue.sort((a, b) => a.startTime - b.startTime);
    } else {
      this._setSubtitle(segment.text);
    }
  }

  _startQueueScheduler() {
    if (this._queueTimer) return;
    this._queueTimer = setInterval(() => this._checkQueue(), 50);
  }

  _stopQueueScheduler() {
    if (this._queueTimer) {
      clearInterval(this._queueTimer);
      this._queueTimer = null;
    }
  }

  _checkQueue() {
    if (!this.audioQueue.length) return;
    const videoTime = this.video?.currentTime ?? 0;
    const videoPaused = this.video?.paused ?? false;

    // Синхронизация паузы: если видео на паузе — TTS тоже
    if (this._currentAudio) {
      if (videoPaused && !this._currentAudio.paused) {
        this._currentAudio.pause();
      } else if (!videoPaused && this._currentAudio.paused && this._currentAudio._yttPlaying) {
        this._currentAudio.play().catch(() => {});
      }
    }

    if (videoPaused) return;

    // Убираем полностью устаревшие сегменты (конец окна + 1с уже прошёл)
    this.audioQueue = this.audioQueue.filter(s => {
      const windowEnd = s.startTime + (s.duration || 5);
      return windowEnd + 1 >= videoTime;
    });
    if (!this.audioQueue.length) return;

    // Ищем сегмент, чьё время наступило
    const nextSeg = this.audioQueue[0];
    if (nextSeg.startTime > videoTime + 0.1) return; // ещё рано

    // Если текущий аудио ещё играет — проверяем, не пора ли его прервать
    if (this._currentAudio && this._currentSegment) {
      const curEnd = this._currentSegment.startTime + (this._currentSegment.duration || 5);
      // Прерываем только если текущий сегмент уже вышел за своё окно
      if (videoTime < curEnd) return; // текущий ещё в своём окне — не прерываем
      // Окно текущего кончилось — прерываем и переходим к следующему
      this._interruptCurrentAudio();
    }

    // Если аудио ещё играет (не прервали) — не начинаем новый
    if (this._currentAudio) return;

    // Убираем все устаревшие до текущего момента, берём ближайший к videoTime
    let playIdx = 0;
    for (let i = 1; i < this.audioQueue.length; i++) {
      if (this.audioQueue[i].startTime <= videoTime + 0.1) playIdx = i;
      else break;
    }
    if (playIdx > 0)
      console.log(`[YTT] Пропускаем ${playIdx} устаревших`);

    const segment = this.audioQueue[playIdx];
    this.audioQueue.splice(0, playIdx + 1);

    console.log(`[YTT] Play: "${segment.text.substring(0, 40)}" ` +
                `@ video=${videoTime.toFixed(1)}s seg=[${segment.startTime.toFixed(1)}s..${(segment.startTime + (segment.duration||5)).toFixed(1)}s]`);
    this._playSegment(segment);
  }

  _interruptCurrentAudio() {
    if (this._currentAudio) {
      this._currentAudio._yttPlaying = false;
      this._currentAudio.pause();
      this._currentAudio = null;
    }
    this._currentSegment = null;
    this._setSubtitle('');
  }

  _playSegment(segment) {
    const videoRate = this.video?.playbackRate ?? 1;

    // Rate-fitting: вписываем TTS ровно в окно сегмента
    // rate = audioDuration / segmentDuration — точное вписывание
    let rate = videoRate;
    if (segment.audioDuration > 0 && segment.duration > 0) {
      rate = (segment.audioDuration / segment.duration) * videoRate;
      // Ограничиваем только крайние случаи: речь понятна до 2.5x
      rate = Math.min(2.5, Math.max(0.7, rate));
    }

    this._currentSegment = segment;
    this._setSubtitle(segment.text);

    try {
      const audio = new Audio(`data:audio/mp3;base64,${segment.audioBase64}`);
      audio.playbackRate = rate;
      audio.volume       = this._transVolume;
      audio._yttPlaying  = true; // флаг что мы его запустили (для паузы)
      this._currentAudio = audio;

      audio.onended = () => {
        if (this._currentAudio === audio) {
          this._currentAudio   = null;
          this._currentSegment = null;
          this._setSubtitle('');
        }
      };
      audio.onerror = () => {
        if (this._currentAudio === audio) {
          this._currentAudio   = null;
          this._currentSegment = null;
          this._setSubtitle('');
        }
      };

      audio.play().catch(() => {
        this._currentAudio   = null;
        this._currentSegment = null;
        this._setSubtitle('');
      });
    } catch (e) {
      console.error('[YTT] Audio error:', e);
      this._currentAudio   = null;
      this._currentSegment = null;
    }
  }

  _onVideoRateChange(newVideoRate) {
    if (!this._currentAudio || !this._currentSegment) return;
    const seg = this._currentSegment;
    let rate  = newVideoRate;
    if (seg.audioDuration > 0 && seg.duration > 0) {
      rate = (seg.audioDuration / seg.duration) * newVideoRate;
      rate = Math.min(2.5, Math.max(0.7, rate));
    }
    this._currentAudio.playbackRate = rate;
  }

  _clearAudio() {
    this.audioQueue = [];
    this._stopQueueScheduler();
    this._interruptCurrentAudio();
  }

  // ── Spinner (стадии обработки) ────────────────────────────────────────────

  _showSpinner(text) {
    if (!this.spinnerEl) return;
    // Если перевод уже активен — не показываем спиннер для промежуточных статусов
    // (кроме seek, когда firstSegmentSent сбрасывается через pause_video)
    const label = this.spinnerEl.querySelector('#ytt-spinner-text');
    if (label) label.textContent = text || 'Обработка…';
    this.spinnerEl.style.display = 'flex';
    // Прячем субтитры пока виден спиннер
    if (this.subtitleEl) this.subtitleEl.style.display = 'none';
  }

  _hideSpinner() {
    if (!this.spinnerEl) return;
    this.spinnerEl.style.display = 'none';
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  _setSubtitle(text) {
    if (!this.subtitleEl) return;
    if (text) {
      this.subtitleEl.textContent = text;
      this.subtitleEl.style.display = 'block';
    } else {
      this.subtitleEl.textContent = '';
      this.subtitleEl.style.display = 'none';
    }
  }

  _setStatus(state) {
    // Обновляем иконку кнопки
    if (this.btnEl) {
      this.btnEl.innerHTML = this._svgLogo(state);
    }

    // Обновляем тогл в панели
    if (!this.panelEl) return;
    const toggleBtn   = this.panelEl.querySelector('#ytt-toggle-switch');
    const toggleLabel = this.panelEl.querySelector('#ytt-toggle-label');

    if (!toggleBtn || !toggleLabel) return;

    if (state === 'connecting') {
      toggleBtn.className   = 'connecting';
      toggleLabel.textContent = 'Подключение…';
    } else if (state === 'active') {
      toggleBtn.className   = 'active';
      toggleLabel.textContent = 'Перевод включён';
      this._hideSpinner();
    } else {
      toggleBtn.className   = '';
      toggleLabel.textContent = 'Перевод выключен';
      this._hideSpinner();
    }
  }

  _isShorts() {
    return location.pathname.startsWith('/shorts/');
  }

  _getVideoId() {
    if (this._isShorts()) {
      const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
      return m ? m[1] : null;
    }
    const m = location.href.match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function isVideoPage() {
  return (location.pathname === '/watch' && location.search.includes('v='))
      || location.pathname.startsWith('/shorts/');
}

let translator = null;

async function bootstrap() {
  if (!isVideoPage()) return;
  if (translator) return;
  translator = new YouTubeTranslator();
  await translator.init();
}

bootstrap();

window.addEventListener('yt-navigate-finish', () => {
  if (translator) translator = null;
  setTimeout(bootstrap, 800);
});
