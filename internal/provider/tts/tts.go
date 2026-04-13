package tts

// Provider — интерфейс TTS-провайдера
type Provider interface {
	// Name возвращает имя провайдера
	Name() string
	// Initialize инициализирует провайдер с настройками
	Initialize(opts Options) error
	// Synthesize генерирует MP3 аудио из текста
	Synthesize(text string, gender string) ([]byte, error)
	// Destroy освобождает ресурсы
	Destroy() error
}

// Options — настройки инициализации TTS
type Options struct {
	Language string
	Voice    string
	APIKey   string
	// Для CosyVoice
	ServerURL      string
	ReferenceAudio []byte
}

// VoiceMap — голоса по языку и полу
type VoiceMap struct {
	Male   string
	Female string
}

// Стандартные голоса Edge TTS по языкам
var EdgeVoices = map[string]VoiceMap{
	"ru": {Male: "ru-RU-DmitryNeural", Female: "ru-RU-SvetlanaNeural"},
	"en": {Male: "en-US-GuyNeural", Female: "en-US-JennyNeural"},
	"es": {Male: "es-ES-AlvaroNeural", Female: "es-ES-ElviraNeural"},
	"de": {Male: "de-DE-ConradNeural", Female: "de-DE-KatjaNeural"},
	"fr": {Male: "fr-FR-HenriNeural", Female: "fr-FR-DeniseNeural"},
	"zh": {Male: "zh-CN-YunxiNeural", Female: "zh-CN-XiaoxiaoNeural"},
	"ja": {Male: "ja-JP-KeitaNeural", Female: "ja-JP-NanamiNeural"},
	"ko": {Male: "ko-KR-InJoonNeural", Female: "ko-KR-SunHiNeural"},
}
