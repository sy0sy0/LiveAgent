import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const webSettings = loader.loadModule("src/lib/webSettings.ts");
const settings = loader.loadModule("@/lib/settings/index.ts");
const settingsSync = loader.loadModule("@/lib/settings/sync.ts");

function installWindow(origin = "https://gateway.example") {
  const store = new Map();
  globalThis.window = {
    location: { origin },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
  };
  return store;
}

test("getWebDefaultSettings enables remote settings from the gateway token", () => {
  installWindow("https://gateway.example");

  const settings = webSettings.getWebDefaultSettings(" token ");
  assert.equal(settings.system.executionMode, "tools");
  assert.equal(settings.system.workdir, "");
  assert.equal(settings.remote.enabled, true);
  assert.equal(settings.remote.gatewayUrl, "https://gateway.example");
  assert.equal(settings.remote.token, "token");
});

test("web chat runtime controls default and follow provider reasoning support", () => {
  installWindow("https://gateway.example");

  const defaults = webSettings.getWebDefaultSettings(" token ");
  assert.deepEqual(defaults.chatRuntimeControls, {
    thinkingEnabled: true,
    nativeWebSearchEnabled: true,
    reasoning: "high",
    reasoningByProvider: {
      claude_code: "high",
      codex_openai_responses: "high",
      codex_openai_completions: "high",
      gemini: "high",
    },
  });

  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({}), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({ providerId: "claude_code" }), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-responses",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({ providerId: "gemini" }), [
    "minimal",
    "low",
    "medium",
    "high",
  ]);

  assert.deepEqual(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        thinkingEnabled: false,
        nativeWebSearchEnabled: false,
        reasoning: "xhigh",
        reasoningByProvider: {
          gemini: "xhigh",
        },
      },
      { providerId: "gemini" },
    ),
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "high",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        gemini: "high",
      },
    },
  );
  assert.deepEqual(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        thinkingEnabled: true,
        nativeWebSearchEnabled: true,
        reasoning: "xhigh",
        reasoningByProvider: {
          codex_openai_completions: "xhigh",
        },
      },
      { providerId: "codex", requestFormat: "openai-completions" },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        gemini: "high",
      },
    },
  );

  assert.deepEqual(
    settings.updateChatRuntimeControlsForProvider(
      defaults.chatRuntimeControls,
      { reasoning: "xhigh" },
      { providerId: "codex", requestFormat: "openai-responses" },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "high",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "high",
        gemini: "high",
      },
    },
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        ...defaults.chatRuntimeControls,
        reasoningByProvider: {
          ...defaults.chatRuntimeControls.reasoningByProvider,
          claude_code: "xhigh",
          gemini: "low",
        },
      },
      { providerId: "claude_code" },
    ).reasoning,
    "xhigh",
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        ...defaults.chatRuntimeControls,
        reasoningByProvider: {
          ...defaults.chatRuntimeControls.reasoningByProvider,
          claude_code: "xhigh",
          gemini: "low",
        },
      },
      { providerId: "gemini" },
    ).reasoning,
    "low",
  );
});

test("loadWebSettings forces current gateway URL/token over stale persisted remote settings", () => {
  const store = installWindow("https://new.example");
  const stale = webSettings.getWebDefaultSettings("old-token");
  stale.remote.gatewayUrl = "https://old.example";
  stale.remote.token = "old-token";
  stale.system.workdir = "/workspace";
  stale.customSettings.projectToolsFileTree = {
    openProjectPathKeys: ["/stale/project"],
    openVersion: 1,
    projects: {},
  };
  stale.customSettings.projectToolsGitReview = {
    openProjectPathKeys: ["/stale/project"],
    openVersion: 1,
  };
  stale.customSettings.projectToolsTunnel = {
    openProjectPathKeys: ["/stale/project"],
    openVersion: 1,
  };
  stale.customSettings.projectToolsSshTunnel = {
    openProjectPathKeys: ["/stale/project"],
    openVersion: 1,
  };
  store.set("liveagent.gateway.webui.settings.v1", JSON.stringify(stale));

  const loaded = webSettings.loadWebSettings(" new-token ");
  assert.equal(loaded.system.workdir, "/workspace");
  assert.equal(loaded.remote.gatewayUrl, "https://new.example");
  assert.equal(loaded.remote.token, "new-token");
  assert.equal(loaded.remote.enabled, true);
  assert.deepEqual(loaded.customSettings.projectToolsFileTree.openProjectPathKeys, []);
  assert.deepEqual(loaded.customSettings.projectToolsGitReview.openProjectPathKeys, []);
  assert.deepEqual(loaded.customSettings.projectToolsTunnel.openProjectPathKeys, []);
  assert.deepEqual(loaded.customSettings.projectToolsSshTunnel.openProjectPathKeys, []);
});

test("gateway settings sync keeps remote connection local and syncs web terminal setting", () => {
  installWindow();
  const current = webSettings.getWebDefaultSettings("token");
  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    system: {
      executionMode: "tools",
      workdir: "/remote-workdir",
      selectedSystemTools: ["http_get_test"],
    },
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "minimal",
      reasoningByProvider: {
        claude_code: "minimal",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "xhigh",
      },
    },
    selectedModel: null,
  });

  assert.equal(synced.system.executionMode, "tools");
  assert.equal(synced.system.workdir, "/remote-workdir");
  assert.deepEqual(synced.system.selectedSystemTools, ["http_get_test"]);
  assert.equal(synced.chatRuntimeControls.thinkingEnabled, false);
  assert.equal(synced.chatRuntimeControls.nativeWebSearchEnabled, false);
  assert.equal(synced.chatRuntimeControls.reasoning, "minimal");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.claude_code, "high");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.codex_openai_responses, "minimal");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.gemini, "high");
  assert.equal(synced.selectedModel, undefined);
  assert.equal(synced.remote.gatewayUrl, "https://gateway.example");
  assert.equal(synced.remote.token, "token");

  const payload = settingsSync.buildGatewaySettingsSyncPayload(synced);
  assert.deepEqual(payload.remote, {
    enableWebTerminal: synced.remote.enableWebTerminal,
    enableWebSshTerminal: synced.remote.enableWebSshTerminal,
    enableWebGit: synced.remote.enableWebGit,
    enableWebTunnels: synced.remote.enableWebTunnels,
  });
  assert.deepEqual(payload.chatRuntimeControls, synced.chatRuntimeControls);
});

test("ssh settings sync redacts stored secrets and carries one-shot secret updates", () => {
  installWindow();
  const source = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          description: "Production jump host",
          host: "prod.example.com",
          port: 2222,
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
          privateKeyPath: "~/.ssh/prod",
          proxy: {
            type: "http",
            url: "http://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "proxy-password",
          },
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod", "missing-host", "ssh-prod"],
        "   ": ["ssh-prod"],
      },
    },
  });
  assert.deepEqual(source.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });

  const redacted = settingsSync.redactSettingsForWebStorage(source);
  assert.deepEqual(redacted.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(redacted.ssh.hosts[0].password, "");
  assert.equal(redacted.ssh.hosts[0].privateKey, "");
  assert.equal(redacted.ssh.hosts[0].proxy.type, "http");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "");
  assert.equal(redacted.ssh.hosts[0].passwordConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(redacted.ssh.hosts[0].proxy.passwordConfigured, true);

  const publicPayload = settingsSync.buildGatewaySettingsSyncPayload(source);
  assert.deepEqual(publicPayload.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(publicPayload.ssh.hosts[0].password, "");
  assert.equal(publicPayload.ssh.hosts[0].privateKey, "");
  assert.equal(publicPayload.ssh.hosts[0].proxy.type, "http");
  assert.equal(publicPayload.ssh.hosts[0].proxy.password, "");
  assert.equal(publicPayload.ssh.hosts[0].passwordConfigured, true);
  assert.equal(publicPayload.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(publicPayload.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.equal(Object.hasOwn(publicPayload, "sshSecretUpdates"), false);

  const privatePayload = settingsSync.buildGatewaySettingsSyncPayload(source, {
    includeProviderApiKeyUpdates: true,
  });
  assert.deepEqual(privatePayload.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(privatePayload.ssh.hosts[0].password, "");
  assert.equal(privatePayload.ssh.hosts[0].privateKey, "");
  assert.equal(privatePayload.ssh.hosts[0].proxy.type, "http");
  assert.equal(privatePayload.ssh.hosts[0].proxy.password, "");
  assert.deepEqual(privatePayload.sshSecretUpdates, {
    "ssh-prod": {
      password: "ssh-password",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      proxyPassword: "proxy-password",
    },
  });
});

test("ssh settings sync merges one-shot secret updates into existing hosts", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "old-password",
          privateKey: "old-key",
          proxy: {
            type: "socks5",
            url: "socks5://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "old-proxy-password",
          },
        },
      ],
    },
  });

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "",
          passwordConfigured: true,
          privateKey: "",
          privateKeyPath: "~/.ssh/prod",
          privateKeyConfigured: true,
          proxy: {
            type: "http",
            url: "http://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "",
            passwordConfigured: true,
          },
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
    sshSecretUpdates: {
      "ssh-prod": {
        password: "new-password",
        privateKey: "new-key",
        proxyPassword: "new-proxy-password",
      },
    },
  });

  assert.equal(synced.ssh.hosts[0].authType, "privateKey");
  assert.equal(synced.ssh.hosts[0].password, "new-password");
  assert.equal(synced.ssh.hosts[0].privateKey, "new-key");
  assert.equal(synced.ssh.hosts[0].proxy.type, "http");
  assert.equal(synced.ssh.hosts[0].proxy.password, "new-proxy-password");
  assert.equal(synced.ssh.hosts[0].passwordConfigured, true);
  assert.equal(synced.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(synced.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.deepEqual(synced.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
});

test("ssh settings sync preserves project host associations when older payload omits them", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });

  const preserved = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
    },
  });
  assert.deepEqual(preserved.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });

  const cleared = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {},
    },
  });
  assert.deepEqual(cleared.ssh.projectHostAssociations, {});
});

test("settings update payload omits unchanged empty ssh hosts for non-ssh updates", () => {
  installWindow();
  const desktop = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });
  const staleWeb = settings.normalizeSettings({
    customSettings: {
      projectToolsSshTunnel: {
        openProjectPathKeys: [],
        openVersion: 0,
      },
    },
    ssh: {
      hosts: [],
      projectHostAssociations: {},
    },
  });
  const nextWeb = settings.updateProjectToolsSshTunnelOpen(staleWeb, "/project-a", true);

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(staleWeb, nextWeb, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(Object.hasOwn(update, "customSettings"), true);

  const merged = settingsSync.applyGatewaySettingsSyncPayload(desktop, update);
  assert.deepEqual(
    merged.ssh.hosts.map((host) => host.id),
    ["ssh-prod"],
  );
  assert.deepEqual(merged.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(settings.isProjectToolsSshTunnelOpen(merged.customSettings, "/project-a"), true);
});

test("settings update payload includes ssh when hosts are explicitly deleted", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });
  const deleted = settings.updateSsh(current, {
    hosts: [],
    projectHostAssociations: {},
  });

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, deleted, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), true);
  assert.deepEqual(update.ssh.hosts, []);
  assert.deepEqual(update.ssh.projectHostAssociations, {});
});

test("settings update payload includes ssh for secret-only ssh updates", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "old-password",
        },
      ],
    },
  });
  const next = settings.normalizeSettings({
    ...current,
    ssh: {
      ...current.ssh,
      hosts: [
        {
          ...current.ssh.hosts[0],
          password: "new-password",
        },
      ],
    },
  });

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), true);
  assert.deepEqual(update.sshSecretUpdates, {
    "ssh-prod": {
      password: "new-password",
    },
  });

  const merged = settingsSync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "new-password");
});

test("workspace project selection stays out of synced system workdir", () => {
  installWindow();
  const resolvedSystem = settings.resolveWorkspaceProjects(
    {
      ...settings.getDefaultSettings().system,
      executionMode: "tools",
      workdir: "/default-workdir",
      workspaceProjects: [
        {
          id: "project-a",
          name: "Project A",
          path: "/project-a",
          kind: "folder",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeWorkspaceProjectId: "project-a",
    },
    "/default-workdir",
  );

  assert.equal(resolvedSystem.workdir, "/default-workdir");
  assert.equal(resolvedSystem.activeWorkspaceProjectId, "project-a");

  const payload = settingsSync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
  );
  assert.equal(Object.hasOwn(payload.system, "activeWorkspaceProjectId"), false);
  assert.equal(payload.system.workdir, "/default-workdir");
});

test("gateway settings sync preserves active workspace project by path when ids differ", () => {
  installWindow();
  const current = settings.normalizeSettings({
    system: settings.resolveWorkspaceProjects(
      {
        ...settings.getDefaultSettings().system,
        executionMode: "tools",
        workdir: "/default-workdir",
        workspaceProjects: [
          {
            id: "web-project-a",
            name: "Project A",
            path: "/project-a",
            kind: "folder",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        activeWorkspaceProjectId: "web-project-a",
      },
      "/default-workdir",
    ),
  });
  const incoming = settingsSync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: settings.resolveWorkspaceProjects(
        {
          ...settings.getDefaultSettings().system,
          executionMode: "tools",
          workdir: "/default-workdir",
          workspaceProjects: [
            {
              id: "desktop-project-a",
              name: "Project A",
              path: "/project-a",
              kind: "folder",
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
        "/default-workdir",
      ),
    }),
  );

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(synced.system.activeWorkspaceProjectId, "desktop-project-a");
});

test("gateway settings sync keeps newer project tool tab open state", () => {
  installWindow();
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        width: 612,
        activeTab: "gitReview",
        activeTabs: {
          "/web/project": "gitReview",
        },
        tabOrders: {
          "/web/project": ["__git_review__", "__file_tree__"],
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/web/project"],
        openVersion: 2,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/web/project"],
        openVersion: 2,
      },
      projectToolsSshTunnel: {
        openProjectPathKeys: ["/web/project"],
        openVersion: 2,
      },
    },
  });

  const staleSynced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    customSettings: {
      projectToolsPanel: {
        width: 360,
        activeTab: "terminal",
        tabOrders: {
          "/desktop/project": ["terminal-1", "__file_tree__"],
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: [],
        openVersion: 1,
      },
      projectToolsTunnel: {
        openProjectPathKeys: [],
        openVersion: 1,
      },
      projectToolsSshTunnel: {
        openProjectPathKeys: [],
        openVersion: 1,
      },
    },
  });
  assert.deepEqual(staleSynced.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.equal(staleSynced.customSettings.projectToolsGitReview.openVersion, 2);
  assert.deepEqual(staleSynced.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.equal(staleSynced.customSettings.projectToolsTunnel.openVersion, 2);
  assert.deepEqual(staleSynced.customSettings.projectToolsSshTunnel.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.equal(staleSynced.customSettings.projectToolsSshTunnel.openVersion, 2);
  assert.equal(staleSynced.customSettings.projectToolsPanel.width, 612);
  assert.equal(staleSynced.customSettings.projectToolsPanel.activeTab, "gitReview");
  assert.deepEqual(staleSynced.customSettings.projectToolsPanel.activeTabs, {
    "/web/project": "gitReview",
  });
  assert.deepEqual(staleSynced.customSettings.projectToolsPanel.tabOrders, {
    "/web/project": ["__git_review__", "__file_tree__"],
  });

  const newerSynced = settingsSync.applyGatewaySettingsSyncPayload(staleSynced, {
    customSettings: {
      projectToolsPanel: {
        width: 360,
        activeTab: "tunnel",
        activeTabs: {
          "/desktop/project": "tunnel",
        },
        tabOrders: {
          "/desktop/project": ["terminal-1", "__tunnel__"],
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 3,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 3,
      },
      projectToolsSshTunnel: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 3,
      },
    },
  });
  assert.deepEqual(newerSynced.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/desktop/project",
  ]);
  assert.equal(newerSynced.customSettings.projectToolsGitReview.openVersion, 3);
  assert.deepEqual(newerSynced.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/desktop/project",
  ]);
  assert.equal(newerSynced.customSettings.projectToolsTunnel.openVersion, 3);
  assert.deepEqual(newerSynced.customSettings.projectToolsSshTunnel.openProjectPathKeys, [
    "/desktop/project",
  ]);
  assert.equal(newerSynced.customSettings.projectToolsSshTunnel.openVersion, 3);
  assert.equal(newerSynced.customSettings.projectToolsPanel.width, 612);
  assert.equal(newerSynced.customSettings.projectToolsPanel.activeTab, "gitReview");
  assert.deepEqual(newerSynced.customSettings.projectToolsPanel.activeTabs, {
    "/web/project": "gitReview",
  });
  assert.deepEqual(newerSynced.customSettings.projectToolsPanel.tabOrders, {
    "/web/project": ["__git_review__", "__file_tree__"],
  });

  const payload = settingsSync.buildGatewaySettingsSyncPayload(newerSynced);
  assert.equal(Object.hasOwn(payload.customSettings, "projectToolsPanel"), false);
  assert.deepEqual(payload.customSettings.projectToolsGitReview, {
    openProjectPathKeys: ["/desktop/project"],
    openVersion: 3,
  });
  assert.deepEqual(payload.customSettings.projectToolsTunnel, {
    openProjectPathKeys: ["/desktop/project"],
    openVersion: 3,
  });
  assert.deepEqual(payload.customSettings.projectToolsSshTunnel, {
    openProjectPathKeys: ["/desktop/project"],
    openVersion: 3,
  });
});

test("gateway settings sync keeps newer project conversation activity", () => {
  installWindow();
  const current = settings.normalizeSettings({
    system: {
      ...settings.getDefaultSettings().system,
      workdir: "/default-workdir",
      workspaceProjects: [
        {
          id: "project-a",
          name: "Project A",
          path: "/project-a",
          kind: "folder",
          createdAt: 1,
          updatedAt: 1,
          lastConversationAt: 1_700_000_000_900,
        },
      ],
    },
  });
  const incoming = settingsSync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: {
        ...settings.getDefaultSettings().system,
        workdir: "/default-workdir",
        workspaceProjects: [
          {
            id: "project-a",
            name: "Project A",
            path: "/project-a",
            kind: "folder",
            createdAt: 1,
            updatedAt: 1,
            lastConversationAt: 1_700_000_000_100,
          },
        ],
      },
    }),
  );

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(
    synced.system.workspaceProjects.find((item) => item.id === "project-a")?.lastConversationAt,
    1_700_000_000_900,
  );
});

test("web remote settings normalize single-slash http gateway URLs", () => {
  const remote = settings.normalizeRemoteSettings({
    enabled: true,
    gatewayUrl: " https:/gateway.example/ ",
    grpcEndpoint: " https:/grpc.example/ ",
    token: " token ",
  });

  assert.equal(remote.gatewayUrl, "https://gateway.example");
  assert.equal(remote.grpcEndpoint, "https://grpc.example");
  assert.equal(remote.token, "token");

  const remoteWithOversizedPort = settings.normalizeRemoteSettings({
    grpcPort: "70000",
  });
  assert.equal(remoteWithOversizedPort.grpcPort, 65_535);
});

test("web cron task normalization preserves finite and exhausted run counts", () => {
  const finite = settings.normalizeCronTask({
    id: "cron-finite",
    type: "bash",
    script: "echo finite",
    remainingExecutions: "2",
  });
  assert.equal(finite.remainingExecutions, 2);

  const exhausted = settings.normalizeCronTask({
    id: "cron-exhausted",
    type: "bash",
    script: "echo exhausted",
    enabled: true,
    remainingExecutions: 0,
  });
  assert.equal(exhausted.remainingExecutions, 0);
  assert.equal(exhausted.enabled, false);

  const invalid = settings.normalizeCronTask({
    id: "cron-invalid",
    type: "bash",
    script: "echo invalid",
    remainingExecutions: "-1",
  });
  assert.equal(invalid.remainingExecutions, undefined);
});

test("web provider normalization keeps native web search toggle", () => {
  const enabledByDefault = settings.normalizeCustomProvider({
    id: "provider-enabled",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(enabledByDefault.nativeWebSearchEnabled, true);

  const disabled = settings.normalizeCustomProvider({
    id: "provider-disabled",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearchEnabled: false,
  });
  assert.equal(disabled.nativeWebSearchEnabled, false);
});
