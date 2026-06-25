import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

type TunnelTtlSeconds = 0 | 900 | 3600 | 14400;

export const TUNNEL_MANAGER_CHANGED_EVENT = "liveagent:tunnel-manager-changed";

type TunnelSummary = {
  id: string;
  slug: string;
  name: string;
  targetUrl: string;
  publicUrl: string;
  createdAt: number;
  expiresAt: number;
  activeConnections: number;
  status: "active" | "expired" | "offline";
  projectPathKey?: string;
  diagnostics?: TunnelDiagnostic[];
};

type TunnelDiagnostic = {
  protocol: "http" | "websocket" | "sse";
  status: "ok" | "failed" | "unknown";
  statusCode: number;
  errorCode: string;
  message: string;
  checkedAt: number;
};

type TunnelManagerTunnelSummary = Omit<TunnelSummary, "activeConnections">;

export type TunnelChangeAction = "create" | "probe" | "close";

export type TunnelManagerChange = {
  action: TunnelChangeAction;
  tunnel: TunnelManagerTunnelSummary;
};

type TunnelCreateInput = {
  targetUrl: string;
  name?: string;
  ttlSeconds: TunnelTtlSeconds;
  projectPathKey?: string;
};

type TunnelManagerAction = "list" | "create" | "probe" | "close";

type TunnelManagerDetails = {
  kind: "tunnel_manager";
  action: TunnelManagerAction;
  tunnels?: TunnelManagerTunnelSummary[];
  tunnel?: TunnelManagerTunnelSummary;
};

const TUNNEL_MANAGER_TOOL: Tool = {
  name: "TunnelManager",
  description:
    "Manage temporary Remote HTTP/WebSocket/SSE tunnels through the Gateway. Use list to inspect active tunnels and diagnostics, create to expose a localhost or IPv4/IPv6 http service, probe to recheck HTTP/WebSocket/SSE diagnostics, and close to revoke a tunnel.",
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("create"), Type.Literal("probe"), Type.Literal("close")],
      {
        description: "Tunnel action to perform.",
      },
    ),
    targetUrl: Type.Optional(
      Type.String({
        description:
          "Required for action=create. HTTP target, e.g. http://localhost:3000, http://127.0.0.1:5173/app, or http://192.168.1.5:8080.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Optional display name for a created tunnel.",
      }),
    ),
    ttlSeconds: Type.Optional(
      Type.Union([Type.Literal(0), Type.Literal(900), Type.Literal(3600), Type.Literal(14400)], {
        description: "Optional tunnel lifetime. Use 0 for unlimited. Defaults to 3600 seconds.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Tunnel id for action=probe or action=close. Preferred over slug when available.",
      }),
    ),
    slug: Type.Optional(
      Type.String({
        description: "Tunnel slug for action=probe or action=close when id is not known.",
      }),
    ),
  }),
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeAction(value: unknown): TunnelManagerAction {
  if (value === "list" || value === "create" || value === "probe" || value === "close") {
    return value;
  }
  throw new Error('TunnelManager.action must be "list", "create", "probe", or "close".');
}

function normalizeTtlSeconds(value: unknown): TunnelTtlSeconds {
  if (value === undefined || value === null) {
    return 3600;
  }
  if (value === 0 || value === 900 || value === 3600 || value === 14400) {
    return value;
  }
  throw new Error("TunnelManager.ttlSeconds must be 0, 900, 3600, or 14400.");
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function formatRemaining(expiresAt: number) {
  if (!expiresAt) return "unlimited";
  const seconds = Math.max(0, Math.floor(expiresAt - Date.now() / 1000));
  if (seconds <= 0) return "expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return minutes > 0 && minutes < 60 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function stripConnectionCount(tunnel: TunnelSummary): TunnelManagerTunnelSummary {
  const { activeConnections: _activeConnections, ...summary } = tunnel;
  return summary;
}

function formatTunnelLine(tunnel: TunnelManagerTunnelSummary) {
  const name = tunnel.name.trim() || tunnel.targetUrl;
  const lines = [
    `- ${name}`,
    `  id: ${tunnel.id}`,
    `  slug: ${tunnel.slug}`,
    `  target: ${tunnel.targetUrl}`,
    `  public: ${tunnel.publicUrl}`,
    `  status: ${tunnel.status}`,
    `  ttl: ${formatRemaining(tunnel.expiresAt)}`,
  ];
  if (tunnel.diagnostics?.length) {
    lines.push("  diagnostics:");
    for (const diagnostic of tunnel.diagnostics) {
      const status =
        diagnostic.status === "ok"
          ? "ok"
          : diagnostic.status === "failed"
            ? `failed:${diagnostic.errorCode || "unknown"}`
            : "unknown";
      const statusCode = diagnostic.statusCode ? ` status=${diagnostic.statusCode}` : "";
      const message = diagnostic.message ? ` ${diagnostic.message}` : "";
      lines.push(`    ${diagnostic.protocol}: ${status}${statusCode}${message}`);
    }
  }
  return lines.join("\n");
}

function okResult(params: {
  toolCall: ToolCall;
  action: TunnelManagerAction;
  text: string;
  tunnels?: TunnelManagerTunnelSummary[];
  tunnel?: TunnelManagerTunnelSummary;
}): ToolResultMessage {
  const details: TunnelManagerDetails = {
    kind: "tunnel_manager",
    action: params.action,
    ...(params.tunnels ? { tunnels: params.tunnels } : {}),
    ...(params.tunnel ? { tunnel: params.tunnel } : {}),
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text: params.text }],
    details,
    isError: false,
    timestamp: Date.now(),
  };
}

function errorResult(
  toolCall: ToolCall,
  message: string,
  action: TunnelManagerAction = "list",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: `TunnelManager failed: ${message}` }],
    details: {
      kind: "tunnel_manager",
      action,
      errors: [message],
    },
    isError: true,
    timestamp: Date.now(),
  };
}

async function listTunnels() {
  return invoke<TunnelSummary[]>("gateway_tunnel_list");
}

async function createTunnel(input: TunnelCreateInput) {
  return invoke<TunnelSummary>("gateway_tunnel_create", { input });
}

async function closeTunnel(id: string) {
  return invoke<TunnelSummary>("gateway_tunnel_close", { tunnel_id: id });
}

async function probeTunnel(id: string) {
  return invoke<TunnelSummary>("gateway_tunnel_probe", { tunnel_id: id });
}

async function resolveTunnelId(args: Record<string, unknown>, action: "probe" | "close") {
  const id = normalizeOptionalText(args.id);
  const slug = normalizeOptionalText(args.slug);
  if (!id && !slug) {
    throw new Error(`TunnelManager.id or TunnelManager.slug is required for action=${action}.`);
  }
  if (id) {
    return id;
  }
  const tunnels = await listTunnels();
  const tunnelId = tunnels.find((tunnel) => tunnel.slug === slug)?.id ?? "";
  if (!tunnelId) {
    throw new Error(`No tunnel found for slug "${slug}".`);
  }
  return tunnelId;
}

async function executeTunnelManager(
  toolCall: ToolCall,
  params: {
    projectPathKey?: string;
    onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
  },
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  if (signal?.aborted) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Cancelled" }],
      details: {},
      isError: true,
      timestamp: Date.now(),
    };
  }

  try {
    const args = asArgs(toolCall.arguments);
    const action = normalizeAction(args.action);

    if (action === "list") {
      const tunnels = (await listTunnels()).map(stripConnectionCount);
      const text =
        tunnels.length === 0
          ? "No Remote tunnels are currently registered."
          : ["Remote tunnels:", ...tunnels.map(formatTunnelLine)].join("\n");
      return okResult({ toolCall, action, text, tunnels });
    }

    if (action === "create") {
      const targetUrl = normalizeOptionalText(args.targetUrl);
      if (!targetUrl) {
        throw new Error("TunnelManager.targetUrl is required for action=create.");
      }
      const tunnel = await createTunnel({
        targetUrl,
        name: normalizeOptionalText(args.name) || undefined,
        ttlSeconds: normalizeTtlSeconds(args.ttlSeconds),
        ...(params.projectPathKey?.trim() ? { projectPathKey: params.projectPathKey.trim() } : {}),
      });
      const visibleTunnel = stripConnectionCount(tunnel);
      await params.onTunnelsChanged?.({ action: "create", tunnel: visibleTunnel });
      return okResult({
        toolCall,
        action,
        text: ["Created Remote tunnel:", formatTunnelLine(visibleTunnel)].join("\n"),
        tunnel: visibleTunnel,
      });
    }

    if (action === "probe") {
      const tunnel = await probeTunnel(await resolveTunnelId(args, "probe"));
      const visibleTunnel = stripConnectionCount(tunnel);
      await params.onTunnelsChanged?.({ action: "probe", tunnel: visibleTunnel });
      return okResult({
        toolCall,
        action,
        text: ["Rechecked Remote tunnel diagnostics:", formatTunnelLine(visibleTunnel)].join("\n"),
        tunnel: visibleTunnel,
      });
    }

    const tunnel = await closeTunnel(await resolveTunnelId(args, "close"));
    const visibleTunnel = stripConnectionCount(tunnel);
    await params.onTunnelsChanged?.({ action: "close", tunnel: visibleTunnel });
    return okResult({
      toolCall,
      action,
      text: ["Closed Remote tunnel:", formatTunnelLine(visibleTunnel)].join("\n"),
      tunnel: visibleTunnel,
    });
  } catch (err) {
    const args = asArgs(toolCall.arguments);
    const action =
      args.action === "create" ||
      args.action === "probe" ||
      args.action === "close" ||
      args.action === "list"
        ? args.action
        : undefined;
    return errorResult(toolCall, asErrorMessage(err), action);
  }
}

export function createTunnelManagerTools(params: {
  enabled: boolean;
  runtimeScope: "chat" | "cron_auto_prompt";
  projectPathKey?: string;
  onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
}): BuiltinToolBundle {
  const tools = params.enabled && params.runtimeScope === "chat" ? [TUNNEL_MANAGER_TOOL] : [];
  return {
    groupId: "system",
    tools,
    executeToolCall: (toolCall, signal) =>
      executeTunnelManager(
        toolCall,
        {
          projectPathKey: params.projectPathKey,
          onTunnelsChanged: params.onTunnelsChanged,
        },
        signal,
      ),
    metadataByName: createBuiltinMetadataMap(
      tools.map((tool) => [
        tool.name,
        {
          groupId: "system" as const,
          kind: "tunnel_manager",
          isReadOnly: false,
          displayCategory: "system" as const,
        },
      ]),
    ),
  };
}
