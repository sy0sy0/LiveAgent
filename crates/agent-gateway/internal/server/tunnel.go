package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

const tunnelBodyChunkSize = 64 * 1024

func publicTunnelProxy(sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if slug, ok := parseTunnelPublicPathWithoutTrailingSlash(r.URL.Path); ok {
			target := "/t/" + slug + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusPermanentRedirect)
			return
		}

		slug, restPath, ok := parseTunnelPublicPath(r.URL.Path)
		if !ok {
			writeTunnelError(w, http.StatusNotFound, "tunnel not found")
			return
		}
		if r.URL.RawQuery != "" {
			restPath += "?" + r.URL.RawQuery
		}

		if isWebSocketUpgrade(r) {
			serveTunnelWebSocket(w, r, sm, slug, restPath)
			return
		}
		serveTunnelHTTP(w, r, sm, slug, restPath)
	}
}

func serveTunnelHTTP(
	w http.ResponseWriter,
	r *http.Request,
	sm *session.Manager,
	slug string,
	restPath string,
) {
	streamID := "http-" + uuid.NewString()
	lease, err := sm.AcquireTunnel(slug, streamID)
	if err != nil {
		writeTunnelAcquireError(w, err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	completed := false
	defer func() {
		cancel()
		if !completed {
			_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: lease.TunnelID(),
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
			})
		}
		lease.Release()
	}()

	start := &gatewayv1.TunnelFrame{
		StreamId: streamID,
		TunnelId: lease.TunnelID(),
		Slug:     slug,
		Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START,
		Method:   r.Method,
		Path:     restPath,
		Headers:  tunnelRequestHeaders(r, lease.Tunnel()),
	}
	if err := sm.SendTunnelFrameToAgent(start); err != nil {
		writeTunnelAcquireError(w, err)
		return
	}

	bodyDone := make(chan struct{})
	go streamTunnelHTTPRequestBody(ctx, sm, lease.TunnelID(), slug, streamID, r.Body, bodyDone)

	responseStarted := false
	responseHeadersWritten := false
	responseStatus := http.StatusOK
	responseHeaders := http.Header{}
	responseRewriteKind := tunnelResponseRewriteNone
	var responseBody []byte
	writeResponseHeaders := func() {
		if responseHeadersWritten {
			return
		}
		writeTunnelHTTPHeaders(w, responseHeaders)
		w.WriteHeader(responseStatus)
		responseHeadersWritten = true
	}
	writeBufferedResponse := func() {
		if responseRewriteKind == tunnelResponseRewriteNone {
			return
		}
		writeResponseHeaders()
		if len(responseBody) > 0 {
			_, _ = w.Write(responseBody)
			responseBody = nil
		}
		flushTunnelResponse(w)
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-lease.Done():
			if !responseStarted {
				writeTunnelError(w, http.StatusBadGateway, "tunnel stream closed")
			} else if !responseHeadersWritten {
				writeBufferedResponse()
			}
			return
		case <-bodyDone:
			bodyDone = nil
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START:
				if responseStarted {
					continue
				}
				responseStarted = true
				status := int(frame.GetStatusCode())
				if status <= 0 {
					status = http.StatusOK
				}
				responseStatus = status
				responseHeaders = tunnelResponseHeaders(frame, lease.Tunnel())
				responseRewriteKind = tunnelResponseRewriteKindFor(r.Method, responseStatus, responseHeaders)
				if responseRewriteKind == tunnelResponseRewriteNone {
					writeResponseHeaders()
					flushTunnelResponse(w)
				}
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY:
				if !responseStarted {
					responseStarted = true
					responseStatus = http.StatusOK
					responseHeaders = http.Header{}
					responseRewriteKind = tunnelResponseRewriteNone
					writeResponseHeaders()
				}
				if body := frame.GetBody(); len(body) > 0 {
					if responseRewriteKind != tunnelResponseRewriteNone {
						if len(responseBody)+len(body) <= tunnelRewriteBodyMaxBytes {
							responseBody = append(responseBody, body...)
							continue
						}
						responseRewriteKind = tunnelResponseRewriteNone
						writeResponseHeaders()
						if len(responseBody) > 0 {
							if _, err := w.Write(responseBody); err != nil {
								return
							}
							responseBody = nil
						}
					}
					writeResponseHeaders()
					if _, err := w.Write(body); err != nil {
						return
					}
					flushTunnelResponse(w)
				}
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END:
				if responseRewriteKind != tunnelResponseRewriteNone {
					body := responseBody
					if rewritten, changed := rewriteTunnelResponseBody(body, lease.Tunnel(), responseRewriteKind); changed {
						body = rewritten
						responseHeaders.Del("Content-Length")
						responseHeaders.Del("Etag")
						responseHeaders.Del("ETag")
					}
					writeResponseHeaders()
					if len(body) > 0 {
						if _, err := w.Write(body); err != nil {
							return
						}
					}
					responseBody = nil
				} else if responseStarted && !responseHeadersWritten {
					writeResponseHeaders()
				}
				completed = true
				flushTunnelResponse(w)
				return
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR:
				if !responseStarted {
					writeTunnelError(w, http.StatusBadGateway, frame.GetError())
				} else if !responseHeadersWritten {
					writeBufferedResponse()
				}
				return
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL:
				if !responseStarted {
					writeTunnelError(w, http.StatusServiceUnavailable, "tunnel canceled")
				} else if !responseHeadersWritten {
					writeBufferedResponse()
				}
				return
			}
		}
	}
}

func serveTunnelWebSocket(
	w http.ResponseWriter,
	r *http.Request,
	sm *session.Manager,
	slug string,
	restPath string,
) {
	streamID := "ws-" + uuid.NewString()
	lease, err := sm.AcquireTunnel(slug, streamID)
	if err != nil {
		writeTunnelAcquireError(w, err)
		return
	}

	if err := sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
		StreamId: streamID,
		TunnelId: lease.TunnelID(),
		Slug:     slug,
		Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL,
		Method:   r.Method,
		Path:     restPath,
		Headers:  tunnelWebSocketRequestHeaders(r, lease.Tunnel()),
	}); err != nil {
		lease.Release()
		writeTunnelAcquireError(w, err)
		return
	}

	wsProtocol, dialErr := awaitTunnelWebSocketDial(lease)
	if dialErr != nil {
		_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
			StreamId: streamID,
			TunnelId: lease.TunnelID(),
			Slug:     slug,
			Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
			Error:    dialErr.Error(),
		})
		lease.Release()
		writeTunnelError(w, http.StatusBadGateway, dialErr.Error())
		return
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(_ *http.Request) bool {
			return true
		},
	}
	if wsProtocol != "" {
		upgrader.Subprotocols = []string{wsProtocol}
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
			StreamId: streamID,
			TunnelId: lease.TunnelID(),
			Slug:     slug,
			Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
		})
		lease.Release()
		return
	}
	ws.SetReadLimit(16 * 1024 * 1024)
	defer lease.Release()
	handleTunnelWebSocket(ws, sm, lease, slug, streamID)
}

func handleTunnelWebSocket(
	ws *websocket.Conn,
	sm *session.Manager,
	lease *session.TunnelStreamLease,
	slug string,
	streamID string,
) {
	closed := false
	defer func() {
		if !closed {
			_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: lease.TunnelID(),
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
			})
		}
		_ = ws.Close()
	}()

	browserFrames := make(chan *gatewayv1.TunnelFrame, 64)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			messageType, body, err := ws.ReadMessage()
			if err != nil {
				return
			}
			wireMessageType := "binary"
			if messageType == websocket.TextMessage {
				wireMessageType = "text"
			}
			frame := &gatewayv1.TunnelFrame{
				StreamId:      streamID,
				TunnelId:      lease.TunnelID(),
				Slug:          slug,
				Kind:          gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME,
				Body:          body,
				WsMessageType: wireMessageType,
			}
			select {
			case browserFrames <- frame:
			case <-lease.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-lease.Done():
			closed = true
			return
		case <-readerDone:
			closed = true
			_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: lease.TunnelID(),
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
			})
			return
		case frame := <-browserFrames:
			if frame != nil {
				_ = sm.SendTunnelFrameToAgent(frame)
			}
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME:
				if strings.EqualFold(frame.GetWsMessageType(), "text") {
					if err := ws.WriteMessage(websocket.TextMessage, frame.GetBody()); err != nil {
						return
					}
				} else {
					if err := ws.WriteMessage(websocket.BinaryMessage, frame.GetBody()); err != nil {
						return
					}
				}
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
				gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR:
				closed = true
				return
			}
		}
	}
}

func awaitTunnelWebSocketDial(lease *session.TunnelStreamLease) (string, error) {
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return "", errors.New("local tunnel websocket dial timed out")
		case <-lease.Done():
			return "", errors.New("tunnel stream closed before websocket dial completed")
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL_OK:
				return strings.TrimSpace(frame.GetWsProtocol()), nil
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL_ERROR:
				message := strings.TrimSpace(frame.GetError())
				if message == "" {
					message = "local tunnel websocket dial failed"
				}
				return "", errors.New(message)
			case gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR,
				gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE:
				message := strings.TrimSpace(frame.GetError())
				if message == "" {
					message = "local tunnel websocket dial failed"
				}
				return "", errors.New(message)
			}
		}
	}
}

func streamTunnelHTTPRequestBody(
	ctx context.Context,
	sm *session.Manager,
	tunnelID string,
	slug string,
	streamID string,
	body io.ReadCloser,
	done chan<- struct{},
) {
	defer close(done)
	defer body.Close()

	buffer := make([]byte, tunnelBodyChunkSize)
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			if sendErr := sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: tunnelID,
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_BODY,
				Body:     chunk,
			}); sendErr != nil {
				return
			}
		}
		if errors.Is(err, io.EOF) {
			_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: tunnelID,
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_END,
			})
			return
		}
		if err != nil {
			_ = sm.SendTunnelFrameToAgent(&gatewayv1.TunnelFrame{
				StreamId: streamID,
				TunnelId: tunnelID,
				Slug:     slug,
				Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				Error:    err.Error(),
			})
			return
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
	}
}

func parseTunnelPublicPath(rawPath string) (string, string, bool) {
	if !strings.HasPrefix(rawPath, "/t/") {
		return "", "", false
	}
	trimmed := strings.TrimPrefix(rawPath, "/t/")
	parts := strings.SplitN(trimmed, "/", 2)
	slug := strings.TrimSpace(parts[0])
	if slug == "" {
		return "", "", false
	}
	if len(parts) == 1 || parts[1] == "" {
		return slug, "/", true
	}
	return slug, "/" + parts[1], true
}

func parseTunnelPublicPathWithoutTrailingSlash(rawPath string) (string, bool) {
	if !strings.HasPrefix(rawPath, "/t/") {
		return "", false
	}
	trimmed := strings.TrimPrefix(rawPath, "/t/")
	if trimmed == "" || strings.Contains(trimmed, "/") {
		return "", false
	}
	return strings.TrimSpace(trimmed), strings.TrimSpace(trimmed) != ""
}

func writeTunnelAcquireError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, session.ErrTunnelNotFound), errors.Is(err, session.ErrTunnelExpired):
		writeTunnelError(w, http.StatusNotFound, "tunnel not found")
	case errors.Is(err, session.ErrAgentOffline):
		writeTunnelError(w, http.StatusServiceUnavailable, "agent offline")
	case errors.Is(err, session.ErrTunnelOverLimit):
		writeTunnelError(w, http.StatusTooManyRequests, "tunnel connection limit exceeded")
	default:
		writeTunnelError(w, http.StatusBadGateway, err.Error())
	}
}

func writeTunnelError(w http.ResponseWriter, status int, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = http.StatusText(status)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(message))
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func tunnelRequestHeaders(r *http.Request, tunnel *gatewayv1.TunnelSummary) []*gatewayv1.TunnelHeader {
	headers := filteredTunnelHeaders(r.Header, true)
	return appendTunnelForwardedHeaders(headers, r, tunnel)
}

func tunnelWebSocketRequestHeaders(r *http.Request, tunnel *gatewayv1.TunnelSummary) []*gatewayv1.TunnelHeader {
	headers := make([]*gatewayv1.TunnelHeader, 0, len(r.Header))
	for name, values := range r.Header {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" || shouldDropTunnelWebSocketRequestHeader(canonical) {
			continue
		}
		for _, value := range values {
			headers = append(headers, &gatewayv1.TunnelHeader{
				Name:  canonical,
				Value: value,
			})
		}
	}
	return appendTunnelForwardedHeaders(headers, r, tunnel)
}

func filteredTunnelResponseHeaders(headers []*gatewayv1.TunnelHeader) http.Header {
	out := http.Header{}
	for _, header := range headers {
		name := http.CanonicalHeaderKey(strings.TrimSpace(header.GetName()))
		if name == "" || shouldDropTunnelHeader(name, false) {
			continue
		}
		out.Add(name, header.GetValue())
	}
	return out
}

func filteredTunnelHeaders(headers http.Header, request bool) []*gatewayv1.TunnelHeader {
	out := make([]*gatewayv1.TunnelHeader, 0, len(headers))
	for name, values := range headers {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" || shouldDropTunnelHeader(canonical, request) {
			continue
		}
		for _, value := range values {
			out = append(out, &gatewayv1.TunnelHeader{
				Name:  canonical,
				Value: value,
			})
		}
	}
	return out
}

func shouldDropTunnelHeader(name string, request bool) bool {
	switch strings.ToLower(name) {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"proxy-connection",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade":
		return true
	case "host":
		return request
	default:
		return false
	}
}

func shouldDropTunnelWebSocketRequestHeader(name string) bool {
	if shouldDropTunnelHeader(name, true) {
		return true
	}
	switch strings.ToLower(name) {
	case "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept":
		return true
	default:
		return false
	}
}

func appendTunnelForwardedHeaders(
	headers []*gatewayv1.TunnelHeader,
	r *http.Request,
	tunnel *gatewayv1.TunnelSummary,
) []*gatewayv1.TunnelHeader {
	if r == nil {
		return headers
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	prefix := ""
	if tunnel != nil && strings.TrimSpace(tunnel.GetSlug()) != "" {
		prefix = "/t/" + strings.TrimSpace(tunnel.GetSlug())
	}
	headers = append(headers,
		&gatewayv1.TunnelHeader{Name: "X-Forwarded-Host", Value: r.Host},
		&gatewayv1.TunnelHeader{Name: "X-Forwarded-Proto", Value: proto},
	)
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		headers = append(headers, &gatewayv1.TunnelHeader{Name: "X-Forwarded-Origin", Value: origin})
	}
	if prefix != "" {
		headers = append(headers, &gatewayv1.TunnelHeader{Name: "X-Forwarded-Prefix", Value: prefix})
	}
	return headers
}

func writeTunnelResponseHeaders(
	w http.ResponseWriter,
	frame *gatewayv1.TunnelFrame,
	tunnel *gatewayv1.TunnelSummary,
) {
	writeTunnelHTTPHeaders(w, tunnelResponseHeaders(frame, tunnel))
}

func tunnelResponseHeaders(
	frame *gatewayv1.TunnelFrame,
	tunnel *gatewayv1.TunnelSummary,
) http.Header {
	headers := filteredTunnelResponseHeaders(frame.GetHeaders())
	for name, values := range headers {
		rewritten := make([]string, 0, len(values))
		for _, value := range values {
			if strings.EqualFold(name, "Location") {
				value = rewriteTunnelLocation(value, tunnel)
			}
			if strings.EqualFold(name, "Set-Cookie") {
				value = rewriteTunnelSetCookiePath(value, tunnel)
			}
			rewritten = append(rewritten, value)
		}
		headers[name] = rewritten
	}
	return headers
}

func writeTunnelHTTPHeaders(w http.ResponseWriter, headers http.Header) {
	for name, values := range headers {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
}

func flushTunnelResponse(w http.ResponseWriter) {
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func rewriteTunnelLocation(value string, tunnel *gatewayv1.TunnelSummary) string {
	if tunnel == nil {
		return value
	}
	target, err := url.Parse(tunnel.GetTargetUrl())
	if err != nil || target.Host == "" {
		return value
	}
	publicPrefix := "/t/" + tunnel.GetSlug()
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	if parsed.IsAbs() {
		if !strings.EqualFold(parsed.Scheme, target.Scheme) || !strings.EqualFold(parsed.Host, target.Host) {
			return value
		}
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		if path == "" {
			path = "/"
		}
		if parsed.RawQuery != "" {
			path += "?" + parsed.RawQuery
		}
		if parsed.Fragment != "" {
			path += "#" + parsed.EscapedFragment()
		}
		return publicPrefix + path
	}
	if strings.HasPrefix(value, "/") {
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		if path == "" {
			path = "/"
		}
		if parsed.RawQuery != "" {
			path += "?" + parsed.RawQuery
		}
		if parsed.Fragment != "" {
			path += "#" + parsed.EscapedFragment()
		}
		return publicPrefix + path
	}
	return value
}

func rewriteTunnelSetCookiePath(value string, tunnel *gatewayv1.TunnelSummary) string {
	if tunnel == nil || tunnel.GetSlug() == "" {
		return value
	}
	parts := strings.Split(value, ";")
	targetBasePath := "/"
	if target, err := url.Parse(tunnel.GetTargetUrl()); err == nil {
		targetBasePath = target.EscapedPath()
	}
	for index, part := range parts {
		trimmed := strings.TrimSpace(part)
		if !strings.HasPrefix(strings.ToLower(trimmed), "path=") {
			continue
		}
		cookiePath := strings.TrimSpace(trimmed[len("path="):])
		if cookiePath == "" {
			cookiePath = "/"
		}
		rest := stripTunnelTargetBasePath(cookiePath, targetBasePath)
		if rest == "" {
			rest = "/"
		}
		prefix := ""
		if leading := len(part) - len(strings.TrimLeft(part, " \t")); leading > 0 {
			prefix = part[:leading]
		}
		parts[index] = fmt.Sprintf("%sPath=/t/%s%s", prefix, tunnel.GetSlug(), rest)
	}
	return strings.Join(parts, ";")
}

func stripTunnelTargetBasePath(pathValue string, basePath string) string {
	pathValue = normalizeTunnelPath(pathValue)
	basePath = normalizeTunnelPath(basePath)
	if basePath == "/" {
		return pathValue
	}
	if pathValue == basePath {
		return "/"
	}
	if strings.HasPrefix(pathValue, strings.TrimRight(basePath, "/")+"/") {
		return strings.TrimPrefix(pathValue, strings.TrimRight(basePath, "/"))
	}
	return pathValue
}

func normalizeTunnelPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "/"
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return value
}

func publicBaseURLFromHTTPRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme := forwardedHeaderFirst(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := forwardedHeaderFirst(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

func forwardedHeaderFirst(value string) string {
	first := strings.TrimSpace(strings.Split(value, ",")[0])
	return strings.TrimSpace(first)
}
