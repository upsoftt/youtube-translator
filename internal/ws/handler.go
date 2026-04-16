package ws

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/gofiber/contrib/websocket"
	"github.com/google/uuid"
	"github.com/upsoftt/youtube-translator/internal/config"
	"github.com/upsoftt/youtube-translator/internal/pipeline"
	"github.com/upsoftt/youtube-translator/internal/session"
)

// Handler управляет WebSocket-подключениями
type Handler struct {
	sessions      *session.Manager
	cfg           *config.Config
	orchestrators sync.Map // sessionID → *pipeline.Orchestrator
}

// NewHandler создаёт WebSocket-хандлер
func NewHandler(sessions *session.Manager, cfg *config.Config) *Handler {
	return &Handler{
		sessions: sessions,
		cfg:      cfg,
	}
}

// HandleConnection обрабатывает одно WebSocket-подключение
func (h *Handler) HandleConnection(c *websocket.Conn) {
	sessionID := uuid.NewString()
	// c — gofiber/contrib/websocket.Conn, c.Conn — *fasthttp/websocket.Conn
	sess := h.sessions.Create(sessionID, c.Conn)
	defer func() {
		h.stopOrchestrator(sessionID)
		h.sessions.Destroy(sessionID)
	}()

	slog.Info("[WS] Клиент подключён", "id", sessionID)

	for {
		_, rawMsg, err := c.ReadMessage()
		if err != nil {
			slog.Info("[WS] Клиент отключён", "id", sessionID, "error", err)
			break
		}

		var msg Message
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			slog.Warn("[WS] Невалидное сообщение", "error", err)
			continue
		}

		h.dispatch(sess, sessionID, &msg)
	}
}

// dispatch маршрутизирует входящее сообщение
func (h *Handler) dispatch(sess *session.Session, sessionID string, msg *Message) {
	switch msg.Type {
	case "start":
		var req StartRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			slog.Warn("[WS] Невалидный start", "error", err)
			return
		}
		slog.Info("[WS] Событие", "type", msg.Type, "session", sessionID)
		h.handleStart(sess, sessionID, &req)

	case "stop":
		slog.Info("[WS] Событие", "type", "stop", "session", sessionID)
		h.handleStop(sessionID)

	case "playback_time":
		var data PlaybackTimeData
		if err := json.Unmarshal(msg.Data, &data); err == nil {
			sess.SetPlaybackTime(data.Time)
		}

	case "seek":
		var data SeekData
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			return
		}
		slog.Info("[WS] Seek", "time", data.Time, "session", sessionID)
		h.handleSeek(sess, sessionID, data.Time)

	case "update_settings":
		var req StartRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			return
		}
		slog.Info("[WS] Обновление настроек", "session", sessionID)
		h.handleStop(sessionID)
		h.handleStart(sess, sessionID, &req)

	default:
		slog.Warn("[WS] Неизвестное событие", "type", msg.Type)
	}
}

// handleStart запускает pipeline перевода
func (h *Handler) handleStart(sess *session.Session, sessionID string, req *StartRequest) {
	// Останавливаем предыдущий если был
	h.stopOrchestrator(sessionID)

	orch := pipeline.NewOrchestrator(
		h.cfg,
		sess.SendMessage,
		sess.GetPlaybackTime,
	)
	h.orchestrators.Store(sessionID, orch)

	preferSubs := true
	if req.Settings.PreferSubtitles != nil {
		preferSubs = *req.Settings.PreferSubtitles
	}

	orch.Start(pipeline.OrchestratorOptions{
		VideoURL:        req.VideoURL,
		SourceLanguage:  detectSourceLanguage(req.Settings),
		TargetLanguage:  req.Settings.TargetLanguage,
		TTSProvider:     req.Settings.TTSProvider,
		TransProvider:   req.Settings.TranslationProvider,
		SeekTime:        req.Settings.SeekTime,
		PreferSubtitles: preferSubs,
		APIKeyDeepgram:  req.Settings.APIKeys.Deepgram,
		APIKeyOpenAI:    req.Settings.APIKeys.OpenAI,
	})
}

// handleStop останавливает pipeline
func (h *Handler) handleStop(sessionID string) {
	h.stopOrchestrator(sessionID)
}

// handleSeek перезапускает pipeline с новой позиции
func (h *Handler) handleSeek(sess *session.Session, sessionID string, timeSec float64) {
	// Получаем текущий оркестратор чтобы извлечь настройки
	// Простой подход: stop + клиент отправит новый start с seekTime
	h.stopOrchestrator(sessionID)
	slog.Info("[WS] Seek — pipeline остановлен, ожидание нового start", "time", timeSec)
}

func (h *Handler) stopOrchestrator(sessionID string) {
	v, ok := h.orchestrators.LoadAndDelete(sessionID)
	if !ok {
		return
	}
	orch := v.(*pipeline.Orchestrator)
	orch.Stop()
	slog.Info("[WS] Orchestrator остановлен", "session", sessionID)
}

// detectSourceLanguage определяет исходный язык (пока захардкожен en)
func detectSourceLanguage(s TranslationSettings) string {
	// TODO: определение по URL или настройкам
	return "en"
}
