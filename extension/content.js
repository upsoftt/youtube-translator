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
    this.isPlayingAudio  = false;
    this._currentAudio   = null;
    this._currentSegment = null;
    this.settings        = {};
    this.playbackTimer   = null;
    this._pendingStart   = null;
    this._queueTimer     = null;
    this._origVolume     = 1.0;
    this._transVolume    = 1.0;
    this._btnPosObs      = null;
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
        targetLanguage: 'ru',
        backendUrl:     'http://localhost:8211',
        openaiApiKey:   '',
        deepgramApiKey: '',
        origVolume:     0.1,
        transVolume:    1.0,
      }, resolve);
    });
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
        if (video && document.querySelector('#movie_player')) {
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

    overlay.appendChild(sub);
    player.appendChild(overlay);

    this.overlay    = overlay;
    this.subtitleEl = sub;

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
    if (this._btnPosObs) { this._btnPosObs.disconnect(); this._btnPosObs = null; }
  }

  _svgLogo(state) {
    const isActive      = state === 'active';
    const isConnecting  = state === 'connecting';
    const strokeL       = 'white';
    const strokeR       = isActive ? '#ff6666' : isConnecting ? '#e6a800' : '#ffffff';
    const fillBubble    = isActive ? 'rgba(200,30,30,0.82)' : 'rgba(0,0,0,0.6)';
    const textColorL    = isActive ? '#fff' : 'white';
    const textColorR    = isActive ? '#fff' : (isConnecting ? '#e6a800' : '#aad4ff');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -1 54 44" width="30" height="26">
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

  _injectPanel(player) {
    const panel = document.createElement('div');
    panel.id = 'ytt-panel';
    panel.style.cssText = `
      display:none;
      position:absolute; bottom:56px; right:8px;
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

      <div class="ytt-vol-row">
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
    this.overlay.appendChild(panel);
    this.panelEl = panel;

    // Ждём монтирования DOM и навешиваем обработчики
    requestAnimationFrame(() => this._bindPanelEvents());
  }

  _bindPanelEvents() {
    const p = this.panelEl;
    if (!p) return;

    // Тогл вкл/выкл
    const toggleBtn = p.querySelector('#ytt-toggle-switch');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this._toggle());
    }

    // Громкость оригинала
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

    // Громкость перевода
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

    // Язык
    const langSelect = p.querySelector('#ytt-lang-select');
    if (langSelect) {
      langSelect.value = this.settings.targetLanguage || 'ru';
      langSelect.addEventListener('change', () => {
        this.settings.targetLanguage = langSelect.value;
        chrome.storage.sync.set({ targetLanguage: langSelect.value });
        // Если перевод активен — перезапускаем с новым языком
        if (this.isActive) {
          this._stopTranslation();
          setTimeout(() => this._startTranslation(), 300);
        }
      });
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
    socket.on('pause_video',  ()  => this.video?.pause());
    socket.on('resume_video', ()  => {
      this.video?.play().catch(() => {});
      this._setStatus('active');
      this._startQueueScheduler();
    });
    socket.on('error',        (d) => console.error('[YTT] Server error:', d.message));
    socket.on('disconnect',   ()  => {
      if (this.isActive) { this.isActive = false; this._setStatus('idle'); }
    });

    this.socket   = socket;
    this.isActive = true;

    const currentTime = this.video?.currentTime ?? 0;
    this._pendingStart = {
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      settings: {
        targetLanguage:      this.settings.targetLanguage || 'ru',
        sttProvider:         'deepgram',
        translationProvider: 'openai',
        ttsProvider:         'deepgram-tts',
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

  // ── Audio queue ───────────────────────────────────────────────────────────

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
    this._queueTimer = setInterval(() => this._checkQueue(), 300);
  }

  _stopQueueScheduler() {
    if (this._queueTimer) {
      clearInterval(this._queueTimer);
      this._queueTimer = null;
    }
  }

  _checkQueue() {
    if (this.isPlayingAudio || !this.audioQueue.length) return;
    const videoTime = this.video?.currentTime ?? 0;

    // Убираем полностью устаревшие сегменты (окно давно прошло)
    this.audioQueue = this.audioQueue.filter(s => {
      const windowEnd = s.startTime + (s.duration || 5);
      return windowEnd + 2 >= videoTime;
    });
    if (!this.audioQueue.length) return;

    // Все кандидаты — сегменты, у которых startTime уже наступил (+ 0.5с lookahead)
    // Берём САМЫЙ ПОЗДНИЙ из них: если несколько накопилось — пропускаем устаревшие
    let playIdx = -1;
    for (let i = 0; i < this.audioQueue.length; i++) {
      if (this.audioQueue[i].startTime <= videoTime + 0.5) playIdx = i;
      else break; // очередь отсортирована, дальше только будущие
    }
    if (playIdx === -1) return;

    // Удаляем все сегменты ДО выбранного (они уже неактуальны)
    if (playIdx > 0)
      console.log(`[YTT] Пропускаем ${playIdx} устаревших, берём t=${this.audioQueue[playIdx].startTime.toFixed(1)}s`);
    const segment = this.audioQueue[playIdx];
    this.audioQueue.splice(0, playIdx + 1);

    console.log(`[YTT] Play: "${segment.text.substring(0, 40)}" ` +
                `@ video=${videoTime.toFixed(1)}s start=${segment.startTime.toFixed(1)}s`);
    this._playSegment(segment);
  }

  async _playSegment(segment) {
    const videoRate  = this.video?.playbackRate ?? 1;
    const videoTime  = this.video?.currentTime ?? 0;
    const drift      = videoTime - segment.startTime; // > 0 → мы опаздываем

    // Rate-fitting с учётом дрейфа:
    // если играем с опозданием — окно для аудио уменьшается
    let rate = videoRate;
    if (segment.audioDuration > 0 && segment.duration > 0) {
      const effectiveDuration = Math.max(0.5, segment.duration - Math.max(0, drift));
      rate = (segment.audioDuration / effectiveDuration) * videoRate;
      rate = Math.min(2.5, Math.max(videoRate, rate));
    }

    this.isPlayingAudio  = true;
    this._currentSegment = segment;
    this._setSubtitle(segment.text);

    try {
      const audio = new Audio(`data:audio/mp3;base64,${segment.audioBase64}`);
      audio.playbackRate = rate;
      audio.volume       = this._transVolume;
      this._currentAudio = audio;

      await new Promise(r => {
        audio.onended = () => r();
        audio.onerror = () => r();

        // Полинг каждые 80мс: синхронизируем паузу TTS с паузой видео
        const syncInterval = setInterval(() => {
          if (!this._currentAudio) { clearInterval(syncInterval); r(); return; }
          const videoPaused = this.video?.paused ?? false;
          if (videoPaused && !audio.paused) {
            audio.pause();
          } else if (!videoPaused && audio.paused) {
            audio.play().catch(() => {});
          }
        }, 80);

        audio.play().catch(() => { clearInterval(syncInterval); r(); });
      });
    } catch (e) {
      console.error('[YTT] Audio error:', e);
    }

    this._currentAudio   = null;
    this._currentSegment = null;
    this.isPlayingAudio  = false;
    this._setSubtitle('');
  }

  _onVideoRateChange(newVideoRate) {
    if (!this._currentAudio || !this._currentSegment) return;
    const seg = this._currentSegment;
    let rate  = newVideoRate;
    if (seg.audioDuration > 0 && seg.duration > 0) {
      rate = (seg.audioDuration / seg.duration) * newVideoRate;
      rate = Math.min(2.5, Math.max(newVideoRate, rate));
    }
    console.log(`[YTT] Rate update → ${newVideoRate.toFixed(2)}x: audio=${rate.toFixed(2)}x`);
    this._currentAudio.playbackRate = rate;
  }

  _clearAudio() {
    this.audioQueue     = [];
    this.isPlayingAudio = false;
    this._stopQueueScheduler();
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio = null;
    }
    this._currentSegment = null;
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
    } else {
      toggleBtn.className   = '';
      toggleLabel.textContent = 'Перевод выключен';
    }
  }

  _getVideoId() {
    const m = location.href.match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function isVideoPage() {
  return location.pathname === '/watch' && location.search.includes('v=');
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
