const DEFAULTS = {
  targetLanguage: 'ru',
  backendUrl:     'http://localhost:8211',
  openaiApiKey:   '',
  deepgramApiKey: '',
};

const $ = id => document.getElementById(id);

// ─── Load ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(DEFAULTS, settings => {
  $('lang').value       = settings.targetLanguage;
  $('backendUrl').value = settings.backendUrl;
  $('openaiKey').value  = settings.openaiApiKey;
  $('deepgramKey').value = settings.deepgramApiKey;

  // Пробуем загрузить ключи с сервера если поля пустые
  if (!settings.openaiApiKey || !settings.deepgramApiKey) {
    fetchKeysFromServer(settings.backendUrl, settings);
  }
});

// ─── Fetch keys from backend ──────────────────────────────────────────────────

async function fetchKeysFromServer(backendUrl, existingSettings) {
  try {
    const resp = await fetch(`${backendUrl}/api/keys`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const keys = await resp.json();

    let changed = false;
    if (keys.openaiApiKey && !existingSettings.openaiApiKey) {
      $('openaiKey').value = keys.openaiApiKey;
      changed = true;
    }
    if (keys.deepgramApiKey && !existingSettings.deepgramApiKey) {
      $('deepgramKey').value = keys.deepgramApiKey;
      changed = true;
    }
    if (changed) {
      setStatus('Ключи загружены с сервера', 'ok');
    }
  } catch {
    // Сервер недоступен — ничего не делаем
  }
}

// ─── Check server ─────────────────────────────────────────────────────────────

$('btnCheck').addEventListener('click', async () => {
  const url = $('backendUrl').value.trim() || DEFAULTS.backendUrl;
  setStatus('Проверяю…', '');
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      const data = await resp.json();
      setStatus(`Сервер работает ✓  (v${data.version || '?'})`, 'ok');
    } else {
      setStatus(`Ошибка: HTTP ${resp.status}`, 'err');
    }
  } catch (e) {
    setStatus('Сервер недоступен', 'err');
  }
});

// ─── Save ─────────────────────────────────────────────────────────────────────

$('btnSave').addEventListener('click', () => {
  const settings = {
    targetLanguage: $('lang').value,
    backendUrl:     $('backendUrl').value.trim() || DEFAULTS.backendUrl,
    openaiApiKey:   $('openaiKey').value.trim(),
    deepgramApiKey: $('deepgramKey').value.trim(),
  };

  chrome.storage.sync.set(settings, () => {
    setStatus('Сохранено ✓', 'ok');
    setTimeout(() => setStatus('', ''), 2500);
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function setStatus(text, cls) {
  const el = $('status');
  el.textContent  = text;
  el.className    = 'status-bar' + (cls ? ' ' + cls : '');
}
