import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createTunnel(overrides = {}) {
  return {
    id: "tun-1",
    slug: "abc123",
    name: "Local app",
    targetUrl: "http://localhost:3000",
    publicUrl: "https://gateway.example.test/t/abc123",
    createdAt: 1_700_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    activeConnections: 0,
    status: "active",
    ...overrides,
  };
}

function createToolCall(args) {
  return {
    type: "toolCall",
    id: "call-tunnel",
    name: "TunnelManager",
    arguments: args,
  };
}

async function buildRegistry(params = {}) {
  const loader = createTsModuleLoader();
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  return buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    currentChatModel: { customProviderId: "p", model: "m" },
    selectedSystemToolIds: [],
    mcpSettings: { selected: [], servers: [] },
    enabledMcpServerIds: [],
    selectableMcpServers: [],
    ...params,
  });
}

test("TunnelManager is injected only when Remote Web Tunnels are enabled and gateway is online", async () => {
  const disabledRegistry = await buildRegistry({
    remoteWebTunnelsEnabled: false,
    remoteGatewayOnline: true,
  });
  assert.equal(disabledRegistry.hasTool("TunnelManager"), false);

  const offlineRegistry = await buildRegistry({
    remoteWebTunnelsEnabled: true,
    remoteGatewayOnline: false,
  });
  assert.equal(offlineRegistry.hasTool("TunnelManager"), false);

  const enabledRegistry = await buildRegistry({
    remoteWebTunnelsEnabled: true,
    remoteGatewayOnline: true,
  });
  assert.equal(enabledRegistry.hasTool("TunnelManager"), true);
  assert.equal(
    enabledRegistry.metadataByName.get("TunnelManager").kind,
    "tunnel_manager",
  );

  const cronRegistry = await buildRegistry({
    runtimeScope: "cron_auto_prompt",
    remoteWebTunnelsEnabled: true,
    remoteGatewayOnline: true,
  });
  assert.equal(cronRegistry.hasTool("TunnelManager"), false);
});

test("TunnelManager list/create/probe/close call gateway tunnel commands", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "gateway_tunnel_list") {
            return [createTunnel()];
          }
          if (command === "gateway_tunnel_create") {
            return createTunnel({
              id: "tun-created",
              slug: "created",
              targetUrl: args.input.targetUrl,
              name: args.input.name ?? "",
              ...(args.input.ttlSeconds === 0 ? { expiresAt: 0 } : {}),
            });
          }
          if (command === "gateway_tunnel_close") {
            return createTunnel({
              id: args.tunnel_id,
              status: "expired",
            });
          }
          if (command === "gateway_tunnel_probe") {
            return createTunnel({
              id: args.tunnel_id,
              diagnostics: [
                {
                  protocol: "websocket",
                  status: "ok",
                  statusCode: 101,
                  errorCode: "",
                  message: "WebSocket probe succeeded",
                  checkedAt: 1_700_000_100,
                },
                {
                  protocol: "sse",
                  status: "unknown",
                  statusCode: 0,
                  errorCode: "",
                  message: "",
                  checkedAt: 1_700_000_100,
                },
              ],
            });
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createTunnelManagerTools } = loader.loadModule("src/lib/tools/tunnelManagerTools.ts");
  const changes = [];
  const bundle = createTunnelManagerTools({
    enabled: true,
    runtimeScope: "chat",
    projectPathKey: "project:/workspace",
    onTunnelsChanged: (change) => changes.push(change),
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["TunnelManager"]);

  const listResult = await bundle.executeToolCall(createToolCall({ action: "list" }));
  assert.equal(listResult.isError, false);
  assert.equal(listResult.details.kind, "tunnel_manager");
  assert.equal(listResult.details.tunnels.length, 1);
  assert.equal(listResult.details.tunnels[0].activeConnections, undefined);
  assert.doesNotMatch(listResult.content[0].text, /activeConnections|connections/i);

  const createResult = await bundle.executeToolCall(
    createToolCall({
      action: "create",
      targetUrl: "http://localhost:5173/app",
      name: "Vite",
      ttlSeconds: 0,
    }),
  );
  assert.equal(createResult.isError, false);
  assert.equal(createResult.details.tunnel.id, "tun-created");
  assert.equal(createResult.details.tunnel.activeConnections, undefined);
  assert.doesNotMatch(createResult.content[0].text, /activeConnections|connections/i);
  assert.match(createResult.content[0].text, /unlimited/);

  const probeResult = await bundle.executeToolCall(
    createToolCall({ action: "probe", id: "tun-1" }),
  );
  assert.equal(probeResult.isError, false);
  assert.equal(probeResult.details.tunnel.activeConnections, undefined);
  assert.match(probeResult.content[0].text, /diagnostics:/);
  assert.match(probeResult.content[0].text, /websocket: ok status=101/);
  assert.match(probeResult.content[0].text, /sse: unknown/);

  const closeBySlugResult = await bundle.executeToolCall(
    createToolCall({ action: "close", slug: "abc123" }),
  );
  assert.equal(closeBySlugResult.isError, false);
  assert.equal(closeBySlugResult.details.tunnel.activeConnections, undefined);

  assert.deepEqual(
    invocations.map((call) => [call.command, call.args]),
    [
      ["gateway_tunnel_list", undefined],
      [
        "gateway_tunnel_create",
        {
          input: {
            targetUrl: "http://localhost:5173/app",
            name: "Vite",
            ttlSeconds: 0,
            projectPathKey: "project:/workspace",
          },
        },
      ],
      ["gateway_tunnel_probe", { tunnel_id: "tun-1" }],
      ["gateway_tunnel_list", undefined],
      ["gateway_tunnel_close", { tunnel_id: "tun-1" }],
    ],
  );
  assert.deepEqual(
    changes.map((change) => [change.action, change.tunnel.id, change.tunnel.activeConnections]),
    [
      ["create", "tun-created", undefined],
      ["probe", "tun-1", undefined],
      ["close", "tun-1", undefined],
    ],
  );
});

test("TunnelManager rejects invalid arguments before invoking gateway commands", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const { createTunnelManagerTools } = loader.loadModule("src/lib/tools/tunnelManagerTools.ts");
  const bundle = createTunnelManagerTools({ enabled: true, runtimeScope: "chat" });

  const invalidAction = await bundle.executeToolCall(createToolCall({ action: "delete" }));
  assert.equal(invalidAction.isError, true);
  assert.match(invalidAction.content[0].text, /action/);

  const missingTarget = await bundle.executeToolCall(createToolCall({ action: "create" }));
  assert.equal(missingTarget.isError, true);
  assert.match(missingTarget.content[0].text, /targetUrl/);

  const invalidTtl = await bundle.executeToolCall(
    createToolCall({ action: "create", targetUrl: "http://localhost:3000", ttlSeconds: 60 }),
  );
  assert.equal(invalidTtl.isError, true);
  assert.match(invalidTtl.content[0].text, /ttlSeconds/);

  const missingCloseTarget = await bundle.executeToolCall(createToolCall({ action: "close" }));
  assert.equal(missingCloseTarget.isError, true);
  assert.match(missingCloseTarget.content[0].text, /id or TunnelManager.slug/);

  const missingProbeTarget = await bundle.executeToolCall(createToolCall({ action: "probe" }));
  assert.equal(missingProbeTarget.isError, true);
  assert.match(missingProbeTarget.content[0].text, /id or TunnelManager.slug/);

  assert.deepEqual(invocations, []);
});
