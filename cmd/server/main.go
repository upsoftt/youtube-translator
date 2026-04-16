package main

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/joho/godotenv"
	"github.com/upsoftt/youtube-translator/internal/config"
	"github.com/upsoftt/youtube-translator/internal/session"
	"github.com/upsoftt/youtube-translator/internal/web"
	"github.com/upsoftt/youtube-translator/internal/ws"
)

func main() {
	// Загружаем .env (если есть)
	_ = godotenv.Load()

	cfg := config.Load()

	// Освобождаем порт если занят
	ensurePortFree(cfg.Port)

	// Fiber app
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
	})

	app.Use(logger.New(logger.Config{
		Format:     "${time} ${method} ${path} ${status} ${latency}\n",
		TimeFormat: "15:04:05",
	}))

	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
	}))

	// Сессии
	sessionManager := session.NewManager()

	// HTTP маршруты
	web.NewRoutes(app, cfg)

	// WebSocket
	wsHandler := ws.NewHandler(sessionManager, cfg)
	app.Use("/ws", func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})
	app.Get("/ws", websocket.New(wsHandler.HandleConnection))

	// Баннер
	printBanner(cfg)

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		slog.Info("[Server] Получен сигнал завершения")
		sessionManager.ShutdownAll()
		_ = app.Shutdown()
	}()

	// Запуск
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	if err := app.Listen(addr); err != nil {
		slog.Error("[Server] Ошибка запуска", "error", err)
		os.Exit(1)
	}
}

// ensurePortFree проверяет и освобождает порт
func ensurePortFree(port int) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 1_000_000_000)
	if err != nil {
		return // Порт свободен
	}
	conn.Close()

	slog.Info("[Startup] Порт занят, убиваю старый процесс...", "port", port)

	if runtime.GOOS == "windows" {
		// Находим PID по порту
		out, err := exec.Command("cmd", "/c",
			fmt.Sprintf(`netstat -ano | findstr ":%d " | findstr LISTENING`, port),
		).Output()
		if err == nil && len(out) > 0 {
			lines := string(out)
			// Последнее поле в строке netstat — PID
			fields := splitFields(lines)
			if len(fields) > 0 {
				pidStr := fields[len(fields)-1]
				if pid, err := strconv.Atoi(pidStr); err == nil && pid > 0 {
					slog.Info("[Startup] Убиваю процесс", "pid", pid)
					_ = exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F").Run()
				}
			}
		}
	} else {
		// Unix: fuser
		out, _ := exec.Command("fuser", fmt.Sprintf("%d/tcp", port)).Output()
		if len(out) > 0 {
			fields := splitFields(string(out))
			for _, pidStr := range fields {
				if pid, err := strconv.Atoi(pidStr); err == nil && pid > 0 {
					slog.Info("[Startup] Убиваю процесс", "pid", pid)
					_ = exec.Command("kill", "-9", strconv.Itoa(pid)).Run()
				}
			}
		}
	}
}

func splitFields(s string) []string {
	var fields []string
	current := ""
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if current != "" {
				fields = append(fields, current)
				current = ""
			}
		} else {
			current += string(r)
		}
	}
	if current != "" {
		fields = append(fields, current)
	}
	return fields
}

func printBanner(cfg *config.Config) {
	fmt.Println()
	fmt.Println("  ┌─────────────────────────────────────────┐")
	fmt.Println("  │       YouTube Translator v2.0 (Go)       │")
	fmt.Println("  │       Chrome Extension Backend            │")
	fmt.Println("  │                                          │")
	fmt.Printf("  │  API:       http://%s:%d        │\n", cfg.Host, cfg.Port)
	fmt.Printf("  │  WebSocket: ws://%s:%d/ws      │\n", cfg.Host, cfg.Port)
	fmt.Println("  │                                          │")
	fmt.Printf("  │  STT:         %-24s│\n", cfg.DefaultSTT)
	fmt.Printf("  │  Translation: %-24s│\n", cfg.DefaultTranslation)
	fmt.Printf("  │  TTS:         %-24s│\n", cfg.DefaultTTS)
	fmt.Println("  └─────────────────────────────────────────┘")
	fmt.Println()
}
