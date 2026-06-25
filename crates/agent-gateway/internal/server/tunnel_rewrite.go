package server

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"golang.org/x/net/html"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

const tunnelRewriteBodyMaxBytes = 4 * 1024 * 1024

type tunnelResponseRewriteKind int

const (
	tunnelResponseRewriteNone tunnelResponseRewriteKind = iota
	tunnelResponseRewriteHTML
	tunnelResponseRewriteCSS
)

func tunnelResponseRewriteKindFor(
	method string,
	status int,
	headers http.Header,
) tunnelResponseRewriteKind {
	if strings.EqualFold(strings.TrimSpace(method), http.MethodHead) {
		return tunnelResponseRewriteNone
	}
	if status < http.StatusOK ||
		status == http.StatusNoContent ||
		status == http.StatusNotModified {
		return tunnelResponseRewriteNone
	}
	if strings.TrimSpace(headers.Get("Content-Encoding")) != "" {
		return tunnelResponseRewriteNone
	}

	contentType := strings.TrimSpace(headers.Get("Content-Type"))
	if contentType == "" {
		return tunnelResponseRewriteNone
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = contentType
	}
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))

	switch {
	case mediaType == "text/html" || mediaType == "application/xhtml+xml":
		return tunnelResponseRewriteHTML
	case mediaType == "text/css":
		return tunnelResponseRewriteCSS
	default:
		return tunnelResponseRewriteNone
	}
}

func rewriteTunnelResponseBody(
	body []byte,
	tunnel *gatewayv1.TunnelSummary,
	kind tunnelResponseRewriteKind,
) ([]byte, bool) {
	if len(body) == 0 || kind == tunnelResponseRewriteNone || tunnelPublicPathPrefix(tunnel) == "" {
		return body, false
	}
	if !utf8.Valid(body) {
		return body, false
	}

	original := string(body)
	rewritten := original
	switch kind {
	case tunnelResponseRewriteHTML:
		rewritten = rewriteTunnelHTMLBody(rewritten, tunnel)
	case tunnelResponseRewriteCSS:
		rewritten = rewriteTunnelCSSBody(rewritten, tunnel)
	}
	if rewritten == original {
		return body, false
	}
	return []byte(rewritten), true
}

func rewriteTunnelHTMLBody(input string, tunnel *gatewayv1.TunnelSummary) string {
	tokenizer := html.NewTokenizer(strings.NewReader(input))
	var builder strings.Builder
	changed := false
	injected := false
	shim := tunnelRuntimeBootstrapScript(tunnel)

	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			if errors := tokenizer.Err(); errors != nil && errors != io.EOF {
				return input
			}
			break
		}

		raw := string(tokenizer.Raw())
		if tokenType != html.StartTagToken && tokenType != html.SelfClosingTagToken {
			builder.WriteString(raw)
			continue
		}

		token := tokenizer.Token()
		tagName := strings.ToLower(strings.TrimSpace(token.Data))
		if !injected && shim != "" && tagName == "script" {
			builder.WriteString(shim)
			injected = true
			changed = true
		}
		tokenChanged := false
		for index := range token.Attr {
			attr := &token.Attr[index]
			key := strings.ToLower(strings.TrimSpace(attr.Key))
			switch {
			case isTunnelHTMLURLAttribute(key):
				rewritten := rewriteTunnelBodyURL(attr.Val, tunnel)
				if rewritten != attr.Val {
					attr.Val = rewritten
					tokenChanged = true
				}
			case key == "style":
				rewritten := rewriteTunnelCSSBody(attr.Val, tunnel)
				if rewritten != attr.Val {
					attr.Val = rewritten
					tokenChanged = true
				}
			}
		}
		if tokenChanged {
			builder.WriteString(token.String())
			changed = true
		} else {
			builder.WriteString(raw)
		}
		if !injected && shim != "" && tagName == "head" {
			builder.WriteString(shim)
			injected = true
			changed = true
		}
	}

	if !injected && shim != "" {
		return shim + builder.String()
	}
	if !changed {
		return input
	}
	return builder.String()
}

func rewriteTunnelCSSBody(input string, tunnel *gatewayv1.TunnelSummary) string {
	lexer := css.NewLexer(parse.NewInputString(input))
	var builder strings.Builder
	changed := false

	for {
		tokenType, data := lexer.Next()
		if tokenType == css.ErrorToken {
			if err := lexer.Err(); err != nil && err != io.EOF {
				return input
			}
			break
		}

		token := string(data)
		if tokenType == css.URLToken {
			if rewritten, ok := rewriteTunnelCSSURLToken(token, tunnel); ok {
				builder.WriteString(rewritten)
				changed = true
				continue
			}
		}
		builder.WriteString(token)
	}

	if !changed {
		return input
	}
	return builder.String()
}

func isTunnelHTMLURLAttribute(key string) bool {
	switch key {
	case "href", "src", "action", "poster", "data", "formaction", "xlink:href":
		return true
	default:
		return false
	}
}

func tunnelRuntimeBootstrapScript(tunnel *gatewayv1.TunnelSummary) string {
	prefix := tunnelPublicPathPrefix(tunnel)
	if prefix == "" {
		return ""
	}
	config, err := json.Marshal(map[string]string{
		"basePath": prefix,
	})
	if err != nil {
		return ""
	}
	return `<script data-liveagent-tunnel-shim>(function(config){` +
		`if(window.__LIVEAGENT_TUNNEL__&&window.__LIVEAGENT_TUNNEL__.installed)return;` +
		`var base=String(config.basePath||"").replace(/\/+$/,"");` +
		`window.__LIVEAGENT_TUNNEL__={basePath:base,installed:true};` +
		`function rw(input){if(input==null||!base)return input;var raw=input instanceof URL?input.href:String(input);var u;try{u=new URL(raw,location.href)}catch(_){return input}` +
		`if(u.host!==location.host||!/^(http:|https:|ws:|wss:)$/i.test(u.protocol))return input;` +
		`if(u.pathname===base||u.pathname.indexOf(base+"/")===0)return u.href;` +
		`u.pathname=base+(u.pathname==="/"?"/":u.pathname);return u.href}` +
		`function rwWs(input){var out=rw(input);try{var u=new URL(String(out),location.href);if(u.protocol==="http:")u.protocol="ws:";if(u.protocol==="https:")u.protocol="wss:";return u.href}catch(_){return out}}` +
		`if(window.WebSocket){var NativeWebSocket=window.WebSocket;window.WebSocket=function(url,protocols){return new NativeWebSocket(rwWs(url),protocols)};window.WebSocket.prototype=NativeWebSocket.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){window.WebSocket[k]=NativeWebSocket[k]})}` +
		`if(window.EventSource){var NativeEventSource=window.EventSource;window.EventSource=function(url,options){return new NativeEventSource(rw(url),options)};window.EventSource.prototype=NativeEventSource.prototype}` +
		`if(window.fetch){var nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){if(input instanceof Request)return nativeFetch(new Request(rw(input.url),input),init);return nativeFetch(rw(input),init)}}` +
		`if(window.XMLHttpRequest){var open=window.XMLHttpRequest.prototype.open;window.XMLHttpRequest.prototype.open=function(method,url){arguments[1]=rw(url);return open.apply(this,arguments)}}` +
		`})(` + string(config) + `);</script>`
}

func rewriteTunnelCSSURLToken(token string, tunnel *gatewayv1.TunnelSummary) (string, bool) {
	openIndex := strings.Index(token, "(")
	closeIndex := strings.LastIndex(token, ")")
	if openIndex < 0 || closeIndex < openIndex {
		return token, false
	}

	before := token[:openIndex+1]
	inner := token[openIndex+1 : closeIndex]
	after := token[closeIndex:]
	leadingLen := len(inner) - len(strings.TrimLeft(inner, " \t\r\n\f"))
	trailingLen := len(inner) - len(strings.TrimRight(inner, " \t\r\n\f"))
	if leadingLen+trailingLen > len(inner) {
		return token, false
	}
	leading := inner[:leadingLen]
	trailing := inner[len(inner)-trailingLen:]
	value := inner[leadingLen : len(inner)-trailingLen]
	if value == "" {
		return token, false
	}

	quote := byte(0)
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		quote = value[0]
		value = value[1 : len(value)-1]
	}

	rewritten := rewriteTunnelBodyURL(value, tunnel)
	if rewritten == value {
		return token, false
	}
	if quote == 0 && !css.IsURLUnquoted([]byte(rewritten)) {
		quote = '"'
	}
	if quote != 0 {
		rewritten = string(quote) + rewritten + string(quote)
	}
	return before + leading + rewritten + trailing + after, true
}

func rewriteTunnelBodyURL(value string, tunnel *gatewayv1.TunnelSummary) string {
	prefix := tunnelPublicPathPrefix(tunnel)
	if prefix == "" {
		return value
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" ||
		strings.HasPrefix(trimmed, "#") ||
		strings.HasPrefix(trimmed, "//") {
		return value
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return value
	}
	target, targetErr := url.Parse(tunnel.GetTargetUrl())
	if parsed.IsAbs() {
		if targetErr != nil || target.Host == "" {
			return value
		}
		if !strings.EqualFold(parsed.Scheme, target.Scheme) ||
			!strings.EqualFold(parsed.Host, target.Host) {
			return value
		}
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
	}
	if !strings.HasPrefix(trimmed, "/") {
		return value
	}
	if trimmed == prefix || strings.HasPrefix(trimmed, prefix+"/") {
		return value
	}

	path := parsed.EscapedPath()
	if targetErr == nil && target.Host != "" {
		path = stripTunnelTargetBasePath(path, target.EscapedPath())
	}
	return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
}

func tunnelPublicPathPrefix(tunnel *gatewayv1.TunnelSummary) string {
	if tunnel == nil {
		return ""
	}
	slug := strings.TrimSpace(tunnel.GetSlug())
	if slug == "" {
		return ""
	}
	return "/t/" + slug
}

func pathOrRoot(path string) string {
	if strings.TrimSpace(path) == "" {
		return "/"
	}
	return path
}

func appendTunnelURLQueryAndFragment(path string, parsed *url.URL) string {
	if parsed == nil {
		return path
	}
	if parsed.RawQuery != "" {
		path += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		path += "#" + parsed.EscapedFragment()
	}
	return path
}
