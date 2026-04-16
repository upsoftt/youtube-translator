package pipeline

import (
	"context"
	"log/slog"
	"sync"

	"github.com/upsoftt/youtube-translator/internal/config"
	"github.com/upsoftt/youtube-translator/internal/media"
	"github.com/upsoftt/youtube-translator/internal/provider/translation"
	"github.com/upsoftt/youtube-translator/internal/provider/tts"
)

// Orchestrator координирует free mode: субтитры → pipeline → клиент.
// Запускается при start, останавливается при stop/seek.
type Orchestrator struct {
	cfg             *config.Config
	sendFn          func(string, interface{}) // отправка сообщений клиенту
	getPlaybackTime func() float64

	pipeline   *Pipeline
	translator translation.Provider
	ttsEngine  tts.Provider

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	mu     sync.Mutex
}

// OrchestratorOptions — параметры запуска оркестратора
type OrchestratorOptions struct {
	VideoURL        string
	SourceLanguage  string
	TargetLanguage  string
	TTSProvider     string
	TransProvider   string
	SeekTime        float64
	PreferSubtitles bool
	APIKeyDeepgram  string
	APIKeyOpenAI    string
}

// NewOrchestrator создаёт оркестратор free mode
func NewOrchestrator(
	cfg *config.Config,
	sendFn func(string, interface{}),
	getPlaybackTime func() float64,
) *Orchestrator {
	return &Orchestrator{
		cfg:             cfg,
		sendFn:          sendFn,
		getPlaybackTime: getPlaybackTime,
	}
}

// Start запускает free mode pipeline
func (o *Orchestrator) Start(opts OrchestratorOptions) {
	o.mu.Lock()
	defer o.mu.Unlock()

	// Если уже запущен — останавливаем
	if o.cancel != nil {
		o.stopLocked()
	}

	o.ctx, o.cancel = context.WithCancel(context.Background())

	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		o.run(opts)
	}()
}

// Stop останавливает текущий pipeline
func (o *Orchestrator) Stop() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.stopLocked()
}

func (o *Orchestrator) stopLocked() {
	if o.cancel != nil {
		o.cancel()
		o.cancel = nil
	}
	// Unlock чтобы не было deadlock (run может вызывать методы под mu)
	o.mu.Unlock()
	o.wg.Wait()
	o.mu.Lock()

	// Уничтожаем провайдеры
	if o.pipeline != nil {
		o.pipeline.Stop()
		o.pipeline = nil
	}
	if o.translator != nil {
		_ = o.translator.Destroy()
		o.translator = nil
	}
	if o.ttsEngine != nil {
		_ = o.ttsEngine.Destroy()
		o.ttsEngine = nil
	}
}

// run — основная горутина free mode
func (o *Orchestrator) run(opts OrchestratorOptions) {
	slog.Info("[Orchestrator] Запуск free mode", "url", opts.VideoURL)

	// 1. Инициализация провайдеров
	o.sendStatus("Инициализация провайдеров…")

	trans, err := o.createTranslator(opts)
	if err != nil {
		slog.Error("[Orchestrator] Ошибка создания переводчика", "error", err)
		o.sendError("Ошибка инициализации перевода: " + err.Error())
		return
	}
	o.mu.Lock()
	o.translator = trans
	o.mu.Unlock()

	ttsEng, err := o.createTTS(opts)
	if err != nil {
		slog.Error("[Orchestrator] Ошибка создания TTS", "error", err)
		o.sendError("Ошибка инициализации TTS: " + err.Error())
		return
	}
	o.mu.Lock()
	o.ttsEngine = ttsEng
	o.mu.Unlock()

	// Отправляем информацию о провайдерах
	o.sendFn("provider_info", map[string]string{
		"stt":         "subtitles",
		"translation": trans.Name(),
		"tts":         ttsEng.Name(),
	})

	// 2. Загружаем субтитры
	o.sendStatus("Загрузка субтитров…")

	sourceLang := opts.SourceLanguage
	if sourceLang == "" {
		sourceLang = "en"
	}

	subs, err := media.FetchYouTubeSubtitles(o.cfg, opts.VideoURL, sourceLang)
	if err != nil {
		slog.Error("[Orchestrator] Ошибка загрузки субтитров", "error", err)
		o.sendError("Ошибка загрузки субтитров: " + err.Error())
		return
	}

	if len(subs) == 0 {
		slog.Warn("[Orchestrator] Субтитры не найдены")
		o.sendError("Субтитры для этого видео недоступны")
		return
	}

	slog.Info("[Orchestrator] Субтитры загружены", "segments", len(subs))

	// 3. Создаём pipeline
	sendSegment := func(seg OutputSegment) {
		o.sendFn("segment", seg)
	}
	statusFn := func(msg string) {
		o.sendStatus(msg)
	}
	onFirstSeg := func() {
		o.sendFn("resume_video", nil)
	}

	pipe := NewPipeline(o.ctx, trans, ttsEng, sendSegment, statusFn, onFirstSeg)
	o.mu.Lock()
	o.pipeline = pipe
	o.mu.Unlock()

	// 4. Пауза видео для накопления буфера
	o.sendFn("pause_video", nil)
	o.sendStatus("Перевод текста…")

	// 5. Подаём сегменты в pipeline (пропуская те, что до seekTime)
	for _, sub := range subs {
		if o.ctx.Err() != nil {
			break
		}

		// Пропускаем сегменты до seekTime
		if sub.StartTime+sub.Duration < opts.SeekTime {
			continue
		}

		pipe.Feed(RawSegment{
			Text:      sub.Text,
			StartTime: sub.StartTime,
			Duration:  sub.Duration,
			Gender:    "",
		})
	}

	slog.Info("[Orchestrator] Все сегменты поданы в pipeline")
}

func (o *Orchestrator) sendStatus(msg string) {
	o.sendFn("status", map[string]string{"message": msg})
}

func (o *Orchestrator) sendError(msg string) {
	o.sendFn("error", map[string]string{"message": msg})
}

// createTranslator создаёт провайдер перевода по настройкам
func (o *Orchestrator) createTranslator(opts OrchestratorOptions) (translation.Provider, error) {
	p := &translation.MyMemoryProvider{}

	sourceLang := opts.SourceLanguage
	if sourceLang == "" {
		sourceLang = "en"
	}
	targetLang := opts.TargetLanguage
	if targetLang == "" {
		targetLang = "ru"
	}

	err := p.Initialize(translation.Options{
		SourceLanguage: sourceLang,
		TargetLanguage: targetLang,
	})
	return p, err
}

// createTTS создаёт TTS провайдер по настройкам
func (o *Orchestrator) createTTS(opts OrchestratorOptions) (tts.Provider, error) {
	p := &tts.EdgeTTSProvider{}

	targetLang := opts.TargetLanguage
	if targetLang == "" {
		targetLang = "ru"
	}

	err := p.Initialize(tts.Options{
		Language: targetLang,
	})
	return p, err
}
