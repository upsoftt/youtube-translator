package stt

// Segment — распознанный сегмент речи
type Segment struct {
	Text      string
	StartTime float64
	EndTime   float64
	Duration  float64
	Gender    string // "male", "female", "unknown"
}

// Provider — интерфейс STT-провайдера
type Provider interface {
	Name() string
	Initialize(opts Options) error
	// ProcessChunk обрабатывает аудио-чанк; вызывает onSegment при распознавании текста
	ProcessChunk(audioChunk []byte, onSegment func(Segment)) error
	Destroy() error
}

// Options — настройки инициализации
type Options struct {
	APIKey          string
	Language        string
	GetPlaybackTime func() float64
}
