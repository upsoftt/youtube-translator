package config

import (
	"os"
	"strconv"
)

// Config содержит все настройки сервера из переменных окружения
type Config struct {
	Port     int
	Host     string
	YtdlpPath  string
	FfmpegPath string

	// API ключи (серверные fallback)
	DeepgramAPIKey string
	OpenAIAPIKey   string

	// Провайдеры по умолчанию
	DefaultSTT         string
	DefaultTranslation string
	DefaultTTS         string

	// CosyVoice
	CosyVoiceURL    string
	CosyVoiceAPIKey string
}

// Load загружает конфигурацию из переменных окружения
func Load() *Config {
	c := &Config{
		Port:               getEnvInt("PORT", 8212),
		Host:               getEnv("HOST", "0.0.0.0"),
		YtdlpPath:          getEnv("YTDLP_PATH", "yt-dlp"),
		FfmpegPath:         getEnv("FFMPEG_PATH", "ffmpeg"),
		DeepgramAPIKey:     getEnv("DEEPGRAM_API_KEY", ""),
		OpenAIAPIKey:       getEnv("OPENAI_API_KEY", ""),
		DefaultSTT:         getEnv("DEFAULT_STT_PROVIDER", "local-whisper"),
		DefaultTranslation: getEnv("DEFAULT_TRANSLATION_PROVIDER", "libre"),
		DefaultTTS:         getEnv("DEFAULT_TTS_PROVIDER", "edge-tts"),
		CosyVoiceURL:       getEnv("COSYVOICE_URL", "http://localhost:8020"),
		CosyVoiceAPIKey:    getEnv("COSYVOICE_API_KEY", ""),
	}
	return c
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
