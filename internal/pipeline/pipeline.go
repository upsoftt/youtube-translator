package pipeline

import (
	"context"
	"encoding/base64"
	"log/slog"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/upsoftt/youtube-translator/internal/media"
	"github.com/upsoftt/youtube-translator/internal/provider/translation"
	"github.com/upsoftt/youtube-translator/internal/provider/tts"
)

// RawSegment — сырой сегмент текста из STT или субтитров
type RawSegment struct {
	Text      string
	StartTime float64
	Duration  float64
	Gender    string
}

// OutputSegment — готовый сегмент для отправки клиенту
type OutputSegment struct {
	ID            string  `json:"id"`
	Text          string  `json:"text"`
	StartTime     float64 `json:"startTime"`
	Duration      float64 `json:"duration"`
	AudioDuration float64 `json:"audioDuration"`
	AudioBase64   string  `json:"audioBase64"`
}

// translatedSegment — промежуточный результат перевода (между стадиями)
type translatedSegment struct {
	sentences []string
	raw       RawSegment
}

// Pipeline — двухстадийный concurrent pipeline:
//
//	Stage 1 (translate): segmentCh → перевод → разбиение на предложения → ttsCh
//	Stage 2 (tts+send):  ttsCh → TTS → отправка клиенту
//
// Стадии работают параллельно: пока TTS озвучивает сегмент N,
// перевод уже обрабатывает N+1, N+2. Сегменты уходят клиенту наперёд.
type Pipeline struct {
	translator translation.Provider
	ttsEngine  tts.Provider
	sendFn     func(OutputSegment) // отправка клиенту
	statusFn   func(string)        // обновление статуса

	ctx       context.Context
	cancel    context.CancelFunc
	segmentCh chan RawSegment        // вход: сырые сегменты
	ttsCh     chan translatedSegment // между стадиями: переведённые сегменты
	wg        sync.WaitGroup
	counter   int
	counterMu sync.Mutex

	firstSent  bool
	firstMu    sync.Mutex
	onFirstSeg func() // вызывается при первом сегменте (resume_video)
}

// NewPipeline создаёт двухстадийный pipeline
func NewPipeline(
	ctx context.Context,
	translator translation.Provider,
	ttsEngine tts.Provider,
	sendFn func(OutputSegment),
	statusFn func(string),
	onFirstSeg func(),
) *Pipeline {
	pCtx, pCancel := context.WithCancel(ctx)
	p := &Pipeline{
		translator: translator,
		ttsEngine:  ttsEngine,
		sendFn:     sendFn,
		statusFn:   statusFn,
		ctx:        pCtx,
		cancel:     pCancel,
		segmentCh:  make(chan RawSegment, 10),  // большой буфер — все субтитры сразу
		ttsCh:      make(chan translatedSegment, 5), // буфер между стадиями
		onFirstSeg: onFirstSeg,
	}

	// Stage 1: перевод (горутина)
	p.wg.Add(1)
	go p.translateWorker()

	// Stage 2: TTS + отправка (горутина)
	p.wg.Add(1)
	go p.ttsWorker()

	return p
}

// Feed добавляет сегмент в pipeline
func (p *Pipeline) Feed(seg RawSegment) {
	select {
	case p.segmentCh <- seg:
	case <-p.ctx.Done():
	}
}

// Stop завершает pipeline и ждёт окончания обработки
func (p *Pipeline) Stop() {
	p.cancel()
	close(p.segmentCh)
	p.wg.Wait()
}

// translateWorker — Stage 1: переводит сегменты и кладёт в ttsCh
func (p *Pipeline) translateWorker() {
	defer p.wg.Done()
	defer close(p.ttsCh)

	for seg := range p.segmentCh {
		if p.ctx.Err() != nil {
			return
		}

		p.firstMu.Lock()
		isFirst := !p.firstSent
		p.firstMu.Unlock()

		if isFirst {
			p.statusFn("Перевод текста…")
		}

		translated, err := p.translateWithRetry(seg.Text)
		if err != nil {
			slog.Error("[Pipeline] Ошибка перевода", "error", err)
			continue
		}
		if strings.TrimSpace(translated) == "" {
			continue
		}

		sentences := splitIntoSentences(translated)

		select {
		case p.ttsCh <- translatedSegment{sentences: sentences, raw: seg}:
		case <-p.ctx.Done():
			return
		}
	}
}

// ttsWorker — Stage 2: озвучивает и отправляет клиенту
func (p *Pipeline) ttsWorker() {
	defer p.wg.Done()

	for ts := range p.ttsCh {
		if p.ctx.Err() != nil {
			return
		}

		durationPerSentence := ts.raw.Duration / float64(len(ts.sentences))

		for i, sentence := range ts.sentences {
			if p.ctx.Err() != nil {
				return
			}

			p.firstMu.Lock()
			isFirst := !p.firstSent
			p.firstMu.Unlock()

			if isFirst {
				p.statusFn("Озвучивание…")
			}

			sentenceStart := ts.raw.StartTime + float64(i)*durationPerSentence

			// TTS
			audioData, err := p.ttsWithRetry(sentence, ts.raw.Gender)
			if err != nil {
				slog.Error("[Pipeline] Ошибка TTS", "error", err)
			}

			audioDuration := media.GetMp3Duration(audioData)

			p.counterMu.Lock()
			p.counter++
			num := p.counter
			p.counterMu.Unlock()

			segment := OutputSegment{
				ID:            uuid.NewString(),
				Text:          sentence,
				StartTime:     sentenceStart,
				Duration:      durationPerSentence,
				AudioDuration: audioDuration,
			}

			if len(audioData) > 0 {
				segment.AudioBase64 = encodeBase64(audioData)
			}

			p.sendFn(segment)

			slog.Info("[Pipeline] Сегмент отправлен",
				"num", num,
				"text", truncateText(sentence, 50),
				"start", sentenceStart,
				"audioDur", audioDuration,
			)

			// Первый сегмент → resume video
			p.firstMu.Lock()
			if !p.firstSent {
				p.firstSent = true
				p.firstMu.Unlock()
				p.statusFn("Перевод активен")
				if p.onFirstSeg != nil {
					p.onFirstSeg()
				}
			} else {
				p.firstMu.Unlock()
			}
		}
	}
}

func (p *Pipeline) translateWithRetry(text string) (string, error) {
	translated, err := p.translator.Translate(text)
	if err != nil {
		slog.Warn("[Pipeline] Перевод fail #1, retry", "error", err)
		translated, err = p.translator.Translate(text)
	}
	return translated, err
}

func (p *Pipeline) ttsWithRetry(text, gender string) ([]byte, error) {
	audio, err := p.ttsEngine.Synthesize(text, gender)
	if err != nil {
		slog.Warn("[Pipeline] TTS fail #1, retry", "error", err)
		audio, err = p.ttsEngine.Synthesize(text, gender)
	}
	return audio, err
}

// splitIntoSentences разбивает текст на предложения (макс ~120 символов)
func splitIntoSentences(text string) []string {
	var sentences []string
	current := ""

	parts := splitByPunctuation(text)

	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}

		if len(current)+len(trimmed) > 120 && current != "" {
			sentences = append(sentences, strings.TrimSpace(current))
			current = trimmed
		} else {
			if current != "" {
				current += " "
			}
			current += trimmed
		}
	}

	if strings.TrimSpace(current) != "" {
		sentences = append(sentences, strings.TrimSpace(current))
	}

	if len(sentences) == 0 {
		return []string{text}
	}
	return sentences
}

func splitByPunctuation(text string) []string {
	var result []string
	current := ""
	for _, r := range text {
		current += string(r)
		if r == '.' || r == '!' || r == '?' {
			result = append(result, current)
			current = ""
		}
	}
	if current != "" {
		result = append(result, current)
	}
	return result
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func encodeBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
