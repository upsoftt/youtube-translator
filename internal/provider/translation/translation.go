package translation

// Provider — интерфейс провайдера перевода
type Provider interface {
	Name() string
	Initialize(opts Options) error
	Translate(text string) (string, error)
	Destroy() error
}

// Options — настройки инициализации
type Options struct {
	APIKey         string
	SourceLanguage string
	TargetLanguage string
}
