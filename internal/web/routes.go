package web

import (
	"github.com/gofiber/fiber/v2"
	"github.com/upsoftt/youtube-translator/internal/config"
	"github.com/upsoftt/youtube-translator/internal/provider/tts"
)

// NewRoutes регистрирует HTTP-маршруты (только API, без web UI)
func NewRoutes(app *fiber.App, cfg *config.Config) {
	r := &routes{cfg: cfg}

	app.Get("/health", r.health)
	app.Get("/api/keys", r.apiKeys)
	app.Get("/api/tts-providers", r.ttsProviders)
}

type routes struct {
	cfg *config.Config
}

func (r *routes) health(c *fiber.Ctx) error {
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

func (r *routes) apiKeys(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"deepgram": r.cfg.DeepgramAPIKey != "",
		"openai":   r.cfg.OpenAIAPIKey != "",
	})
}

func (r *routes) ttsProviders(c *fiber.Ctx) error {
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
