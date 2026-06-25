package session

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

const TunnelProbeTimeout = 5 * time.Second

func (m *Manager) ProbeTunnel(
	ctx context.Context,
	identifier string,
	publicBaseURL string,
) (*gatewayv1.TunnelSummary, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, ErrTunnelNotFound
	}
	now := time.Now()
	online := m.IsOnline()
	m.tunnels.mu.Lock()
	tunnelID := identifier
	if bySlug := m.tunnels.tunnelIDBySlug[identifier]; bySlug != "" {
		tunnelID = bySlug
	}
	record := m.tunnels.tunnelsByID[tunnelID]
	if record == nil || record.closed {
		m.tunnels.mu.Unlock()
		return nil, ErrTunnelNotFound
	}
	if isTunnelExpired(record, now) {
		m.tunnels.mu.Unlock()
		return nil, ErrTunnelExpired
	}
	publicURL := strings.TrimSpace(record.publicURL)
	if publicURL == "" {
		publicURL = buildTunnelPublicURL(publicBaseURL, record.slug)
	}
	slug := record.slug
	recordID := record.id
	m.tunnels.mu.Unlock()

	diagnostics := ProbePublicTunnel(ctx, publicURL)
	if updated, err := m.SetTunnelDiagnostics(recordID, diagnostics); err == nil {
		return updated, nil
	}
	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()
	if record := m.tunnels.tunnelsByID[recordID]; record != nil && !record.closed {
		record.diagnostics = cloneTunnelDiagnostics(diagnostics)
		return tunnelSummaryLocked(record, time.Now(), online), nil
	}
	if slug != "" {
		return &gatewayv1.TunnelSummary{
			Id:          recordID,
			Slug:        slug,
			PublicUrl:   publicURL,
			Status:      "expired",
			Diagnostics: diagnostics,
		}, nil
	}
	return nil, ErrTunnelNotFound
}

func ProbePublicTunnel(ctx context.Context, publicURL string) []*gatewayv1.TunnelDiagnostic {
	checkedAt := time.Now().Unix()
	return []*gatewayv1.TunnelDiagnostic{
		probePublicTunnelHTTP(ctx, publicURL, "http", checkedAt),
		probePublicTunnelHTTP(ctx, publicURL, "sse", checkedAt),
		probePublicTunnelWebSocket(ctx, publicURL, checkedAt),
	}
}

func probePublicTunnelHTTP(
	ctx context.Context,
	publicURL string,
	protocol string,
	checkedAt int64,
) *gatewayv1.TunnelDiagnostic {
	probeURL, err := buildTunnelProbeURL(publicURL, protocol, false)
	if err != nil {
		return tunnelProbeDiagnostic(protocol, "failed", 0, "invalid_url", err.Error(), checkedAt)
	}
	reqCtx, cancel := context.WithTimeout(ctx, TunnelProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, probeURL, nil)
	if err != nil {
		return tunnelProbeDiagnostic(protocol, "failed", 0, "invalid_url", err.Error(), checkedAt)
	}
	req.Header.Set("User-Agent", "LiveAgent-Tunnel-Probe/1")
	client := http.Client{Timeout: TunnelProbeTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return tunnelProbeDiagnostic(protocol, "failed", 0, "network", err.Error(), checkedAt)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if protocol == "sse" {
		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		if resp.StatusCode == http.StatusOK &&
			strings.Contains(contentType, "text/event-stream") &&
			strings.Contains(string(body), "liveagent-probe") {
			return tunnelProbeDiagnostic(protocol, "ok", uint32(resp.StatusCode), "", "SSE probe succeeded", checkedAt)
		}
		return tunnelProbeDiagnostic(
			protocol,
			"failed",
			uint32(resp.StatusCode),
			"sse_unexpected_response",
			fmt.Sprintf("SSE probe returned status %d and content-type %q", resp.StatusCode, resp.Header.Get("Content-Type")),
			checkedAt,
		)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return tunnelProbeDiagnostic(protocol, "ok", uint32(resp.StatusCode), "", "HTTP probe succeeded", checkedAt)
	}
	return tunnelProbeDiagnostic(
		protocol,
		"failed",
		uint32(resp.StatusCode),
		"http_status",
		fmt.Sprintf("HTTP probe returned status %d", resp.StatusCode),
		checkedAt,
	)
}

func probePublicTunnelWebSocket(
	ctx context.Context,
	publicURL string,
	checkedAt int64,
) *gatewayv1.TunnelDiagnostic {
	probeURL, err := buildTunnelProbeURL(publicURL, "ws", true)
	if err != nil {
		return tunnelProbeDiagnostic("websocket", "failed", 0, "invalid_url", err.Error(), checkedAt)
	}
	dialCtx, cancel := context.WithTimeout(ctx, TunnelProbeTimeout)
	defer cancel()
	dialer := websocket.Dialer{HandshakeTimeout: TunnelProbeTimeout}
	ws, resp, err := dialer.DialContext(dialCtx, probeURL, http.Header{
		"User-Agent": []string{"LiveAgent-Tunnel-Probe/1"},
	})
	if err != nil {
		statusCode := uint32(0)
		errorCode := "websocket_dial"
		message := err.Error()
		if resp != nil {
			statusCode = uint32(resp.StatusCode)
			contentType := strings.ToLower(resp.Header.Get("Content-Type"))
			if resp.StatusCode == http.StatusOK && strings.Contains(contentType, "text/html") {
				errorCode = "path_or_upgrade_missed"
				message = "WebSocket probe returned a 200 HTML response; the request likely missed the tunnel websocket upgrade path or a proxy stripped Upgrade headers"
			} else {
				errorCode = "websocket_status"
				message = fmt.Sprintf("WebSocket probe returned status %d", resp.StatusCode)
			}
		}
		return tunnelProbeDiagnostic("websocket", "failed", statusCode, errorCode, message, checkedAt)
	}
	defer ws.Close()
	deadline := time.Now().Add(TunnelProbeTimeout)
	_ = ws.SetReadDeadline(deadline)
	_ = ws.SetWriteDeadline(deadline)
	if err := ws.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		return tunnelProbeDiagnostic("websocket", "failed", 0, "websocket_write", err.Error(), checkedAt)
	}
	messageType, body, err := ws.ReadMessage()
	if err != nil {
		return tunnelProbeDiagnostic("websocket", "failed", 0, "websocket_read", err.Error(), checkedAt)
	}
	if messageType == websocket.TextMessage && string(body) == "pong" {
		return tunnelProbeDiagnostic("websocket", "ok", http.StatusSwitchingProtocols, "", "WebSocket probe succeeded", checkedAt)
	}
	return tunnelProbeDiagnostic("websocket", "failed", http.StatusSwitchingProtocols, "websocket_echo", "WebSocket probe did not receive the expected echo response", checkedAt)
}

func buildTunnelProbeURL(publicURL string, protocol string, websocketURL bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(publicURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid tunnel public URL")
	}
	if websocketURL {
		switch parsed.Scheme {
		case "https":
			parsed.Scheme = "wss"
		case "http":
			parsed.Scheme = "ws"
		default:
			return "", fmt.Errorf("unsupported tunnel public URL scheme %q", parsed.Scheme)
		}
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/.liveagent-tunnel-probe/" + protocol
	return parsed.String(), nil
}

func tunnelProbeDiagnostic(
	protocol string,
	status string,
	statusCode uint32,
	errorCode string,
	message string,
	checkedAt int64,
) *gatewayv1.TunnelDiagnostic {
	return &gatewayv1.TunnelDiagnostic{
		Protocol:   strings.TrimSpace(protocol),
		Status:     strings.TrimSpace(status),
		StatusCode: statusCode,
		ErrorCode:  strings.TrimSpace(errorCode),
		Message:    strings.TrimSpace(message),
		CheckedAt:  checkedAt,
	}
}
