package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

const websocketDefaultTunnelTTLSeconds = 3600

type websocketTunnelCreatePayload struct {
	TargetURL           string `json:"targetUrl"`
	TargetUrl           string `json:"target_url"`
	Name                string `json:"name"`
	TTLSeconds          uint32 `json:"ttlSeconds"`
	TtlSeconds          uint32 `json:"ttl_seconds"`
	ProjectPathKey      string `json:"projectPathKey"`
	ProjectPathKeySnake string `json:"project_path_key"`
}

func tunnelTTLFromPayload(raw json.RawMessage, camelValue uint32, snakeValue uint32) uint32 {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return websocketDefaultTunnelTTLSeconds
	}
	if _, ok := fields["ttlSeconds"]; ok {
		return camelValue
	}
	if _, ok := fields["ttl_seconds"]; ok {
		return snakeValue
	}
	return websocketDefaultTunnelTTLSeconds
}

type websocketTunnelUpdatePayload struct {
	ID                  string `json:"id"`
	TunnelID            string `json:"tunnelId"`
	TunnelId            string `json:"tunnel_id"`
	Slug                string `json:"slug"`
	TargetURL           string `json:"targetUrl"`
	TargetUrl           string `json:"target_url"`
	Name                string `json:"name"`
	TTLSeconds          uint32 `json:"ttlSeconds"`
	TtlSeconds          uint32 `json:"ttl_seconds"`
	ProjectPathKey      string `json:"projectPathKey"`
	ProjectPathKeySnake string `json:"project_path_key"`
}

type websocketTunnelClosePayload struct {
	ID       string `json:"id"`
	TunnelID string `json:"tunnelId"`
	TunnelId string `json:"tunnel_id"`
	Slug     string `json:"slug"`
}

type websocketTunnelProbePayload struct {
	ID       string `json:"id"`
	TunnelID string `json:"tunnelId"`
	TunnelId string `json:"tunnel_id"`
	Slug     string `json:"slug"`
}

func (c *websocketConnection) handleTunnelList(req websocketRequest) {
	_ = c.writeResponse(req.ID, map[string]any{
		"tunnels": websocketTunnelSummariesPayload(c.sm.ListTunnels(), c.publicBaseURL()),
	})
}

func (c *websocketConnection) handleTunnelCreate(req websocketRequest) {
	if !c.sm.WebTunnelsEnabled() {
		_ = c.writeError(req.ID, "web tunnels are disabled in desktop Remote settings")
		return
	}

	var body websocketTunnelCreatePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid tunnel.create payload")
		return
	}
	targetURL := strings.TrimSpace(body.TargetURL)
	if targetURL == "" {
		targetURL = strings.TrimSpace(body.TargetUrl)
	}
	ttlSeconds := tunnelTTLFromPayload(req.Payload, body.TTLSeconds, body.TtlSeconds)
	projectPathKey := strings.TrimSpace(body.ProjectPathKey)
	if projectPathKey == "" {
		projectPathKey = strings.TrimSpace(body.ProjectPathKeySnake)
	}
	prepared, err := c.sm.PrepareTunnelCreate(&gatewayv1.TunnelControlRequest{
		Action:         "create",
		TargetUrl:      targetURL,
		Name:           strings.TrimSpace(body.Name),
		TtlSeconds:     ttlSeconds,
		ProjectPathKey: projectPathKey,
	}, c.publicBaseURL())
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TunnelControl{
			TunnelControl: prepared,
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}
	controlResp := response.GetTunnelControlResp()
	if controlResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	if controlResp.GetErrorMessage() != "" {
		_ = c.writeError(req.ID, controlResp.GetErrorMessage())
		return
	}
	targetOverride := ""
	if tunnel := controlResp.GetTunnel(); tunnel != nil {
		targetOverride = tunnel.GetTargetUrl()
	}
	tunnel, err := c.sm.StorePreparedTunnel(prepared, targetOverride)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	tunnel = c.probeTunnel(tunnel)
	_ = c.writeResponse(req.ID, map[string]any{
		"tunnel":  websocketTunnelSummaryPayload(tunnel, c.publicBaseURL()),
		"tunnels": websocketTunnelSummariesPayload(c.sm.ListTunnels(), c.publicBaseURL()),
	})
}

func (c *websocketConnection) handleTunnelUpdate(req websocketRequest) {
	if !c.sm.WebTunnelsEnabled() {
		_ = c.writeError(req.ID, "web tunnels are disabled in desktop Remote settings")
		return
	}

	var body websocketTunnelUpdatePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid tunnel.update payload")
		return
	}
	identifier := strings.TrimSpace(body.ID)
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelID)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelId)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.Slug)
	}
	if identifier == "" {
		_ = c.writeError(req.ID, "tunnel id is required")
		return
	}
	targetURL := strings.TrimSpace(body.TargetURL)
	if targetURL == "" {
		targetURL = strings.TrimSpace(body.TargetUrl)
	}
	ttlSeconds := tunnelTTLFromPayload(req.Payload, body.TTLSeconds, body.TtlSeconds)
	projectPathKey := strings.TrimSpace(body.ProjectPathKey)
	if projectPathKey == "" {
		projectPathKey = strings.TrimSpace(body.ProjectPathKeySnake)
	}
	prepared, err := c.sm.PrepareTunnelUpdate(&gatewayv1.TunnelControlRequest{
		Action:         "update",
		TunnelId:       identifier,
		TargetUrl:      targetURL,
		Name:           strings.TrimSpace(body.Name),
		TtlSeconds:     ttlSeconds,
		ProjectPathKey: projectPathKey,
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TunnelControl{
			TunnelControl: prepared,
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}
	controlResp := response.GetTunnelControlResp()
	if controlResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	if controlResp.GetErrorMessage() != "" {
		_ = c.writeError(req.ID, controlResp.GetErrorMessage())
		return
	}
	tunnel, err := c.sm.ApplyTunnelUpdate(controlResp.GetTunnel())
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	tunnel = c.probeTunnel(tunnel)
	_ = c.writeResponse(req.ID, map[string]any{
		"tunnel":  websocketTunnelSummaryPayload(tunnel, c.publicBaseURL()),
		"tunnels": websocketTunnelSummariesPayload(c.sm.ListTunnels(), c.publicBaseURL()),
	})
}

func (c *websocketConnection) handleTunnelProbe(req websocketRequest) {
	var body websocketTunnelProbePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid tunnel.probe payload")
		return
	}
	identifier := strings.TrimSpace(body.ID)
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelID)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelId)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.Slug)
	}
	if identifier == "" {
		_ = c.writeError(req.ID, "tunnel id is required")
		return
	}
	var tunnel *gatewayv1.TunnelSummary
	for _, item := range c.sm.ListTunnels() {
		if item.GetId() == identifier || item.GetSlug() == identifier {
			tunnel = item
			break
		}
	}
	if tunnel == nil {
		_ = c.writeError(req.ID, "tunnel not found")
		return
	}
	tunnel = c.probeTunnel(tunnel)
	_ = c.writeResponse(req.ID, map[string]any{
		"tunnel":  websocketTunnelSummaryPayload(tunnel, c.publicBaseURL()),
		"tunnels": websocketTunnelSummariesPayload(c.sm.ListTunnels(), c.publicBaseURL()),
	})
}

func (c *websocketConnection) handleTunnelClose(req websocketRequest) {
	if !c.sm.WebTunnelsEnabled() {
		_ = c.writeError(req.ID, "web tunnels are disabled in desktop Remote settings")
		return
	}

	var body websocketTunnelClosePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid tunnel.close payload")
		return
	}
	identifier := strings.TrimSpace(body.ID)
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelID)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.TunnelId)
	}
	if identifier == "" {
		identifier = strings.TrimSpace(body.Slug)
	}
	if identifier == "" {
		_ = c.writeError(req.ID, "tunnel id is required")
		return
	}

	tunnel, err := c.sm.CloseTunnel(identifier)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	_ = c.sendToAgent(&gatewayv1.GatewayEnvelope{
		RequestId: "tunnel-close-" + tunnel.GetId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TunnelControl{
			TunnelControl: &gatewayv1.TunnelControlRequest{
				Action:   "close",
				TunnelId: tunnel.GetId(),
				Slug:     tunnel.GetSlug(),
			},
		},
	})

	_ = c.writeResponse(req.ID, map[string]any{
		"tunnel":  websocketTunnelSummaryPayload(tunnel, c.publicBaseURL()),
		"tunnels": websocketTunnelSummariesPayload(c.sm.ListTunnels(), c.publicBaseURL()),
	})
}

func (c *websocketConnection) publicBaseURL() string {
	return publicBaseURLFromHTTPRequest(c.req)
}

func (c *websocketConnection) probeTunnel(tunnel *gatewayv1.TunnelSummary) *gatewayv1.TunnelSummary {
	ctx, cancel := context.WithTimeout(c.req.Context(), 3*session.TunnelProbeTimeout)
	defer cancel()
	updated, err := c.sm.ProbeTunnel(ctx, tunnel.GetId(), c.publicBaseURL())
	if err != nil {
		return tunnel
	}
	return updated
}

func websocketTunnelSummariesPayload(
	summaries []*gatewayv1.TunnelSummary,
	publicBaseURL string,
) []map[string]any {
	payload := make([]map[string]any, 0, len(summaries))
	for _, summary := range summaries {
		if item := websocketTunnelSummaryPayload(summary, publicBaseURL); item != nil {
			payload = append(payload, item)
		}
	}
	return payload
}

func websocketTunnelSummaryPayload(
	summary *gatewayv1.TunnelSummary,
	publicBaseURL string,
) map[string]any {
	if summary == nil {
		return nil
	}
	publicURL := strings.TrimSpace(summary.GetPublicUrl())
	if publicURL == "" {
		publicURL = buildPublicTunnelURL(publicBaseURL, summary.GetSlug())
	}
	return map[string]any{
		"id":                 strings.TrimSpace(summary.GetId()),
		"slug":               strings.TrimSpace(summary.GetSlug()),
		"name":               strings.TrimSpace(summary.GetName()),
		"targetUrl":          strings.TrimSpace(summary.GetTargetUrl()),
		"target_url":         strings.TrimSpace(summary.GetTargetUrl()),
		"publicUrl":          publicURL,
		"public_url":         publicURL,
		"createdAt":          summary.GetCreatedAt(),
		"created_at":         summary.GetCreatedAt(),
		"expiresAt":          summary.GetExpiresAt(),
		"expires_at":         summary.GetExpiresAt(),
		"activeConnections":  summary.GetActiveConnections(),
		"active_connections": summary.GetActiveConnections(),
		"status":             strings.TrimSpace(summary.GetStatus()),
		"projectPathKey":     strings.TrimSpace(summary.GetProjectPathKey()),
		"project_path_key":   strings.TrimSpace(summary.GetProjectPathKey()),
		"diagnostics":        websocketTunnelDiagnosticsPayload(summary.GetDiagnostics()),
	}
}

func websocketTunnelDiagnosticsPayload(
	diagnostics []*gatewayv1.TunnelDiagnostic,
) []map[string]any {
	payload := make([]map[string]any, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		if diagnostic == nil {
			continue
		}
		payload = append(payload, map[string]any{
			"protocol":    strings.TrimSpace(diagnostic.GetProtocol()),
			"status":      strings.TrimSpace(diagnostic.GetStatus()),
			"statusCode":  diagnostic.GetStatusCode(),
			"status_code": diagnostic.GetStatusCode(),
			"errorCode":   strings.TrimSpace(diagnostic.GetErrorCode()),
			"error_code":  strings.TrimSpace(diagnostic.GetErrorCode()),
			"message":     strings.TrimSpace(diagnostic.GetMessage()),
			"checkedAt":   diagnostic.GetCheckedAt(),
			"checked_at":  diagnostic.GetCheckedAt(),
		})
	}
	return payload
}

func buildPublicTunnelURL(publicBaseURL string, slug string) string {
	publicBaseURL = strings.TrimRight(strings.TrimSpace(publicBaseURL), "/")
	slug = strings.TrimSpace(slug)
	if publicBaseURL == "" || slug == "" {
		return ""
	}
	return publicBaseURL + "/t/" + slug + "/"
}
