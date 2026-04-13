package ws

import "encoding/json"

// Message — формат WebSocket-сообщений между сервером и клиентом
type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// --- Client → Server ---

// StartRequest — запрос на начало перевода
type StartRequest struct {
	VideoURL string           `json:"videoUrl"`
	Settings TranslationSettings `json:"settings"`
}

// TranslationSettings — настройки сессии перевода
type TranslationSettings struct {
	TargetLanguage    string            `json:"targetLanguage"`
	STTProvider       string            `json:"sttProvider"`
	TranslationProvider string          `json:"translationProvider"`
	TTSProvider       string            `json:"ttsProvider"`
	TTSProviderConfig map[string]string `json:"ttsProviderConfig,omitempty"`
	VoiceClone        bool              `json:"voiceClone,omitempty"`
	TranslationMode   string            `json:"translationMode"` // "free" | "streaming"
	SeekTime          float64           `json:"seekTime,omitempty"`
	PreferSubtitles   *bool             `json:"preferSubtitles,omitempty"`
	APIKeys           APIKeys           `json:"apiKeys"`
}

// APIKeys — клиентские API-ключи
type APIKeys struct {
	Deepgram string `json:"deepgram,omitempty"`
	OpenAI   string `json:"openai,omitempty"`
}

// PlaybackTimeData — обновление позиции воспроизведения
type PlaybackTimeData struct {
	Time float64 `json:"time"`
}

// SeekData — перемотка
type SeekData struct {
	Time float64 `json:"time"`
}

// --- Server → Client ---

// TranslationSegment — сегмент перевода для клиента
type TranslationSegment struct {
	ID            string  `json:"id"`
	Text          string  `json:"text"`
	StartTime     float64 `json:"startTime"`
	Duration      float64 `json:"duration"`
	AudioDuration float64 `json:"audioDuration"`
	AudioBase64   string  `json:"audioBase64"`
}

// StatusData — статус для клиента
type StatusData struct {
	Message string `json:"message"`
}

// ErrorData — ошибка для клиента
type ErrorData struct {
	Message string `json:"message"`
}

// ProviderInfoData — информация об активных провайдерах
type ProviderInfoData struct {
	STT         string `json:"stt"`
	Translation string `json:"translation"`
	TTS         string `json:"tts"`
}

// VideoURLData — прямой URL видео
type VideoURLData struct {
	URL string `json:"url"`
}
