package web

import (
	"html/template"
	"log/slog"
	"path/filepath"

	"github.com/gofiber/fiber/v2"
	"github.com/upsoftt/youtube-translator/internal/config"
	"github.com/upsoftt/youtube-translator/internal/provider/tts"
)

// Routes настраивает HTTP-маршруты
type Routes struct {
	cfg   *config.Config
	pages map[string]*template.Template
}

// NewRoutes создаёт и регистрирует HTTP-маршруты
func NewRoutes(app *fiber.App, cfg *config.Config) *Routes {
	r := &Routes{cfg: cfg, pages: make(map[string]*template.Template)}

	// Загружаем каждую страницу отдельно (layout + page)
	layoutPath := filepath.Join("web", "templates", "layout.html")
	for _, page := range []string{"home", "player"} {
		pagePath := filepath.Join("web", "templates", page+".html")
		tmpl, err := template.ParseFiles(layoutPath, pagePath)
		if err != nil {
			slog.Warn("[Web] Ошибка загрузки шаблона", "page", page, "error", err)
			continue
		}
		r.pages[page] = tmpl
	}

	// Статика
	app.Static("/static", "./web/static")

	// Страницы
	app.Get("/", r.homePage)
	app.Get("/player/:id", r.playerPage)

	// API
	app.Get("/health", r.health)
	app.Get("/api/keys", r.apiKeys)
	app.Get("/api/tts-providers", r.ttsProviders)

	return r
}

func (r *Routes) homePage(c *fiber.Ctx) error {
	tmpl := r.pages["home"]
	if tmpl == nil {
		return c.SendString("YouTube Translator — шаблон home не загружен")
	}
	c.Set("Content-Type", "text/html; charset=utf-8")
	return tmpl.ExecuteTemplate(c.Response().BodyWriter(), "layout", nil)
}

func (r *Routes) playerPage(c *fiber.Ctx) error {
	tmpl := r.pages["player"]
	if tmpl == nil {
		return c.SendString("Player — шаблон player не загружен")
	}
	data := map[string]string{
		"VideoID":  c.Params("id"),
		"VideoURL": c.Query("url", ""),
	}
	c.Set("Content-Type", "text/html; charset=utf-8")
	return tmpl.ExecuteTemplate(c.Response().BodyWriter(), "layout", data)
}

func (r *Routes) health(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status":  "ok",
		"version": "2.0.0",
		"providers": fiber.Map{
			"stt":         []string{"whisper", "deepgram"},
			"translation": []string{"libre", "openai"},
			"tts":         []string{"edge-tts", "openai-tts", "deepgram-tts", "elevenlabs", "cosyvoice"},
		},
	})
}

func (r *Routes) apiKeys(c *fiber.Ctx) error {
	// Возвращаем наличие серверных ключей (без самих значений)
	return c.JSON(fiber.Map{
		"deepgram": r.cfg.DeepgramAPIKey != "",
		"openai":   r.cfg.OpenAIAPIKey != "",
	})
}

func (r *Routes) ttsProviders(c *fiber.Ctx) error {
	providers := []fiber.Map{
		{
			"id":          "edge-tts",
			"name":        "Edge TTS (бесплатный)",
			"description": "Microsoft Edge Neural TTS — бесплатный, хорошее качество",
			"free":        true,
			"languages":   []string{"ru", "en", "es", "de", "fr", "zh", "ja", "ko"},
			"voices":      tts.EdgeVoices,
		},
		{
			"id":          "openai-tts",
			"name":        "OpenAI TTS",
			"description": "OpenAI tts-1 — платный, высокое качество",
			"free":        false,
			"fields":      []fiber.Map{{"key": "apiKey", "label": "OpenAI API Key", "type": "password"}},
		},
		{
			"id":          "deepgram-tts",
			"name":        "DeepGram Aura",
			"description": "DeepGram Aura-2 — платный, быстрый",
			"free":        false,
			"fields":      []fiber.Map{{"key": "apiKey", "label": "DeepGram API Key", "type": "password"}},
		},
		{
			"id":          "elevenlabs",
			"name":        "ElevenLabs",
			"description": "ElevenLabs — платный, премиум качество",
			"free":        false,
			"fields":      []fiber.Map{{"key": "apiKey", "label": "ElevenLabs API Key", "type": "password"}},
		},
	}
	return c.JSON(providers)
}
