"""Bridge: подключает CosyVoice TTS Server (WSL2) к TrayConsole."""
import os
import sys
import subprocess
import threading
import time
from urllib.request import urlopen
from urllib.error import URLError

try:
    from trayconsole_client import TrayConsoleClient
except ImportError:
    # Без TrayConsole — просто запускаем сервер
    subprocess.run(["wsl", "-d", "Ubuntu-22.04", "--", "bash", "/root/start_cosyvoice.sh"])
    sys.exit()

PROJECT_DIR  = os.path.dirname(os.path.abspath(__file__))
PIPE_NAME    = "trayconsole_cosyvoice"
SERVER_PORT  = 8020
HEALTH_URL   = f"http://127.0.0.1:{SERVER_PORT}/health"

# Загружаем ключ из .env файла бэкенда или переменной окружения
def _load_api_key() -> str:
    # 1. Переменная окружения
    key = os.environ.get("COSYVOICE_API_KEY", "")
    if key:
        return key
    # 2. .env файл бэкенда
    env_path = os.path.join(PROJECT_DIR, "apps", "backend", ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("COSYVOICE_API_KEY=") and not line.startswith("#"):
                    return line.split("=", 1)[1].strip()
    return ""

API_KEY = _load_api_key()
if not API_KEY:
    print("[cosyvoice-bridge] ПРЕДУПРЕЖДЕНИЕ: COSYVOICE_API_KEY не задан (проверь .env или переменные окружения)")

process = None
_lock   = threading.Lock()

# ─── утилиты ──────────────────────────────────────────────────────────────────

def check_health() -> bool:
    try:
        from urllib.request import Request
        req = Request(HEALTH_URL, headers={"Authorization": f"Bearer {API_KEY}"})
        resp = urlopen(req, timeout=3)
        return 200 <= resp.status < 300
    except Exception:
        return False

def start_process():
    global process
    with _lock:
        if process and process.poll() is None:
            return
        # Запускаем CosyVoice сервер через WSL2 Ubuntu
        process = subprocess.Popen(
            ["wsl", "-d", "Ubuntu-22.04", "--", "bash", "/root/start_cosyvoice.sh"],
            cwd=PROJECT_DIR,
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
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        # Останавливаем процесс в WSL2 на случай если он ещё живёт
        subprocess.run(
            ["wsl", "-d", "Ubuntu-22.04", "--", "pkill", "-f", "server.py"],
            capture_output=True,
        )
        process = None

def is_alive() -> bool:
    if process is None:
        return False
    if process.poll() is not None:
        return False
    return check_health()

# ─── TrayConsole client ───────────────────────────────────────────────────────

client = TrayConsoleClient(PIPE_NAME)

@client.on("start")
def handle_start():
    start_process()
    for _ in range(150):   # CosyVoice грузит модель ~2 минуты
        if check_health():
            return {"status": "ok"}
        time.sleep(1)
    return {"status": "timeout"}

@client.on("stop")
def handle_stop():
    stop_process()
    return {"status": "stopped"}

@client.on("health")
def handle_health():
    ok = check_health()
    return {"status": "ok" if ok else "error"}

# ─── main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if check_health():
        print(f"[cosyvoice-bridge] Сервер уже запущен на :{SERVER_PORT}")
    else:
        print(f"[cosyvoice-bridge] Запускаем CosyVoice в WSL2...")
        start_process()

        # Ждём готовности (модель грузится ~2 минуты)
        print("[cosyvoice-bridge] Ждём загрузки модели (до 2 минут)...")
        for i in range(150):
            if check_health():
                print(f"[cosyvoice-bridge] Сервер готов за {i+1}с")
                break
            time.sleep(1)
        else:
            print("[cosyvoice-bridge] Сервер не ответил — проверь WSL2")

    client.start()

    MAX_RESTARTS = 3
    restarts = 0
    backoff  = 10

    time.sleep(120)  # пауза перед первой проверкой (модель грузится ~2 минуты)
    try:
        while True:
            if not is_alive():
                time.sleep(5)
                if not is_alive():
                    restarts += 1
                    if restarts > MAX_RESTARTS:
                        print(f"[cosyvoice-bridge] {MAX_RESTARTS} неудачных перезапусков — выходим")
                        break
                    print(f"[cosyvoice-bridge] Перезапуск {restarts}/{MAX_RESTARTS}...")
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 120)
                    start_process()
                    for _ in range(150):
                        if check_health():
                            break
                        time.sleep(1)
                    print("[cosyvoice-bridge] Перезапущен")
                    restarts = 0
                    backoff  = 10
            time.sleep(15)
    except KeyboardInterrupt:
        pass

    stop_process()
    try:
        client.stop()
    except Exception:
        pass
