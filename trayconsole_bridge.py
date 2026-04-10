"""Bridge: подключает YouTube Translator Backend к TrayConsole (discovery-only pattern)."""
import os
import sys
import subprocess
import threading
import time
import webbrowser
from urllib.request import urlopen
from urllib.error import URLError

try:
    from trayconsole_client import TrayConsoleClient
except ImportError:
    # Без TrayConsole — просто запускаем процесс
    os.system("npx tsx apps/backend/src/index.ts")
    sys.exit()

PROJECT_DIR   = os.path.dirname(os.path.abspath(__file__))
PIPE_NAME     = "trayconsole_yttranslator_server"
BACKEND_PORT  = 8211
HEALTH_URL    = f"http://127.0.0.1:{BACKEND_PORT}/health"
FRONTEND_URL  = f"http://localhost:8085"

# Команда запуска бэкенда (с workingDirectory = PROJECT_DIR)
START_CMD = "npx tsx apps/backend/src/index.ts"

process = None
_lock   = threading.Lock()
_health_fails = 0

# ─── утилиты ─────────────────────────────────────────────────────────────────

def check_health() -> bool:
    try:
        resp = urlopen(HEALTH_URL, timeout=3)
        return 200 <= resp.status < 300
    except (URLError, OSError, TimeoutError):
        return False

def start_process():
    global process
    with _lock:
        if process and process.poll() is None:
            return
        process = subprocess.Popen(
            START_CMD,
            cwd=PROJECT_DIR,
            shell=True,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

def stop_process():
    global process
    with _lock:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except Exception:
                process.kill()
        process = None

def is_alive() -> bool:
    global _health_fails
    if check_health():
        _health_fails = 0
        return True
    _health_fails += 1
    return _health_fails > 1   # grace period: первый fail не считается

# ─── TrayConsole ─────────────────────────────────────────────────────────────

client = TrayConsoleClient(PIPE_NAME)

@client.on("status")
def handle_status():
    healthy = check_health()
    return {
        "status": "running" if healthy else "stopped",
        "port":   BACKEND_PORT,
        "health": healthy,
    }

@client.on("shutdown")
def handle_shutdown():
    stop_process()
    return {"status": "ok"}

@client.on("custom:open_ui")
def handle_open_ui():
    webbrowser.open(FRONTEND_URL)
    return {"ok": True}

# ─── main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Discovery: проверить, не запущен ли сервер уже
    if check_health():
        print(f"[bridge] Сервер уже запущен на :{BACKEND_PORT} — подключаемся наблюдателем")
    else:
        print(f"[bridge] Сервер не запущен — стартуем...")
        start_process()

        # Ждём готовности health endpoint (до 30 сек)
        for _ in range(30):
            if check_health():
                break
            time.sleep(1)

        if not check_health():
            print(f"[bridge] Сервер не ответил на /health — завершаем bridge")
            stop_process()
            sys.exit(1)

    print(f"[bridge] Сервер готов — запускаем heartbeat")
    client.start()

    # Watchdog с лимитом перезапусков
    MAX_RESTARTS = 3
    restarts     = 0
    backoff      = 5

    time.sleep(15)   # пауза перед первой проверкой
    try:
        while True:
            if not is_alive():
                time.sleep(5)
                if not is_alive():
                    restarts += 1
                    if restarts > MAX_RESTARTS:
                        print(f"[bridge] {MAX_RESTARTS} неудачных перезапусков — выходим")
                        break

                    print(f"[bridge] Сервер упал, перезапуск {restarts}/{MAX_RESTARTS} через {backoff}s...")
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 60)

                    start_process()
                    for _ in range(30):
                        if check_health():
                            break
                        time.sleep(1)

                    if not check_health():
                        print(f"[bridge] Перезапуск не помог — выходим")
                        break

                    print(f"[bridge] Сервер перезапущен успешно")
                    _health_fails = 0
            else:
                restarts = 0
                backoff  = 5

            time.sleep(10)

    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"[bridge] Критическая ошибка watchdog: {e} — выходим")

    # Гарантированная очистка
    stop_process()
    try:
        client.stop()
    except Exception:
        pass
