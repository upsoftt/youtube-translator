package session

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/fasthttp/websocket"
)

// Session — состояние одного WebSocket-клиента
type Session struct {
	ID           string
	Conn         *websocket.Conn
	Ctx          context.Context
	Cancel       context.CancelFunc
	playbackTime atomic.Value // float64
	writeMu      sync.Mutex
}

// NewSession создаёт новую сессию
func NewSession(id string, conn *websocket.Conn) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		ID:     id,
		Conn:   conn,
		Ctx:    ctx,
		Cancel: cancel,
	}
	s.playbackTime.Store(float64(0))
	return s
}

// SetPlaybackTime обновляет позицию воспроизведения
func (s *Session) SetPlaybackTime(t float64) {
	s.playbackTime.Store(t)
}

// GetPlaybackTime возвращает текущую позицию воспроизведения
func (s *Session) GetPlaybackTime() float64 {
	return s.playbackTime.Load().(float64)
}

// WriteJSON потокобезопасно отправляет JSON-сообщение клиенту
func (s *Session) WriteJSON(v interface{}) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.Conn.WriteJSON(v)
}

// SendMessage отправляет типизированное сообщение клиенту
func (s *Session) SendMessage(msgType string, data interface{}) {
	msg := map[string]interface{}{
		"type": msgType,
		"data": data,
	}
	if err := s.WriteJSON(msg); err != nil {
		slog.Error("[Session] Ошибка отправки", "type", msgType, "error", err)
	}
}

// Close завершает сессию
func (s *Session) Close() {
	s.Cancel()
}
