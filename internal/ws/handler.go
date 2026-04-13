package ws

import (
	"encoding/json"
	"log/slog"

	"github.com/gofiber/contrib/websocket"
	"github.com/google/uuid"
	"github.com/upsoftt/youtube-translator/internal/session"
)

// Handler управляет WebSocket-подключениями
type Handler struct {
	sessions *session.Manager
}

// NewHandler создаёт WebSocket-хандлер
func NewHandler(sessions *session.Manager) *Handler {
	return &Handler{sessions: sessions}
}

// HandleConnection обрабатывает одно WebSocket-подключение
func (h *Handler) HandleConnection(c *websocket.Conn) {
	sessionID := uuid.NewString()
	// c — gofiber/contrib/websocket.Conn, c.Conn — *fasthttp/websocket.Conn
	sess := h.sessions.Create(sessionID, c.Conn)
	defer h.sessions.Destroy(sessionID)

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

		h.dispatch(sess, &msg)
	}
}

// dispatch маршрутизирует входящее сообщение
func (h *Handler) dispatch(sess *session.Session, msg *Message) {
	switch msg.Type {
	case "start":
		var req StartRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			slog.Warn("[WS] Невалидный start", "error", err)
			return
		}
		if msg.Type != "playback_time" {
			slog.Info("[WS] Событие", "type", msg.Type, "session", sess.ID)
		}
		h.handleStart(sess, &req)

	case "stop":
		slog.Info("[WS] Событие", "type", "stop", "session", sess.ID)
		h.handleStop(sess)

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
		slog.Info("[WS] Seek", "time", data.Time, "session", sess.ID)
		h.handleSeek(sess, data.Time)

	case "update_settings":
		var req StartRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			return
		}
		slog.Info("[WS] Обновление настроек", "session", sess.ID)
		h.handleStop(sess)
		h.handleStart(sess, &req)

	default:
		slog.Warn("[WS] Неизвестное событие", "type", msg.Type)
	}
}

// handleStart запускает pipeline перевода
func (h *Handler) handleStart(sess *session.Session, req *StartRequest) {
	// TODO: Фаза 2-3 — создание и запуск pipeline
	sess.SendMessage("status", StatusData{Message: "Инициализация провайдеров..."})
	slog.Info("[WS] Start запрошен", "url", req.VideoURL, "mode", req.Settings.TranslationMode)
}

// handleStop останавливает pipeline
func (h *Handler) handleStop(sess *session.Session) {
	// TODO: Фаза 2-3 — остановка pipeline
	slog.Info("[WS] Stop", "session", sess.ID)
}

// handleSeek обрабатывает перемотку
func (h *Handler) handleSeek(sess *session.Session, timeSec float64) {
	// TODO: Фаза 3 — перезапуск pipeline с новой позиции
	slog.Info("[WS] Seek", "time", timeSec, "session", sess.ID)
}
