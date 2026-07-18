package server

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleProviderList(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ProviderList{
			ProviderList: &gatewayv1.ProviderListRequest{},
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

	resp := response.GetProviderListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var payload any
	raw := strings.TrimSpace(resp.GetProvidersJson())
	if raw == "" {
		payload = []any{}
	} else if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		_ = c.writeError(req.ID, "provider list response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

// handleProviderModels always forwards the fetch to the connected desktop
// agent: provider endpoints may only be reachable from the agent's machine
// (e.g. localhost services), so the gateway never fetches models itself.
func (c *websocketConnection) handleProviderModels(req websocketRequest) {
	var body handler.ProviderModelsRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid provider.models payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ProviderModels{
			ProviderModels: &gatewayv1.ProviderModelsRequest{
				ProviderType:   strings.TrimSpace(body.Type),
				BaseUrl:        strings.TrimSpace(body.BaseURL),
				ApiKey:         strings.TrimSpace(body.APIKey),
				UseSystemProxy: body.UseSystemProxy,
			},
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
	providerModelsResp := response.GetProviderModelsResp()
	if providerModelsResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	var payload any
	if err := json.Unmarshal([]byte(providerModelsResp.GetModelsJson()), &payload); err != nil {
		_ = c.writeError(req.ID, "provider model response is not valid JSON")
		return
	}
	_ = c.writeResponse(req.ID, payload)
}
