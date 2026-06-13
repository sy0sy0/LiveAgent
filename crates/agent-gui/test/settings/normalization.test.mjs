import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const normalize = loader.loadModule("src/lib/settings/normalize.ts");
const sync = loader.loadModule("src/lib/settings/sync.ts");

test("basic provider field normalizers trim values and remove duplicate models", () => {
  assert.equal(normalize.normalizeBaseUrl(" https://api.example.com/v1/// "), "https://api.example.com/v1//");
  assert.equal(normalize.normalizeBaseUrl(" https:/api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(normalize.normalizeApiKey("  token  "), "token");
  assert.deepEqual(
    normalize.normalizeModels([" gpt-5 ", "", "gpt-5", "claude-sonnet"]),
    ["gpt-5", "claude-sonnet"],
  );
});

test("codex provider normalization strips route suffixes and keeps only configured active models", () => {
  const provider = settings.normalizeCustomProvider({
    id: "codex-1",
    name: " Codex ",
    type: "codex",
    baseUrl: " https://api.openai.com/v1/responses/ ",
    apiKey: " key ",
    models: [" gpt-5 ", "gpt-5", { id: "gpt-5-mini", contextWindow: "64000", maxTokens: "4096" }],
    activeModels: ["missing", "gpt-5", "gpt-5"],
    requestFormat: "not-valid",
    reasoning: "xhigh",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: false,
  });

  assert.equal(provider.name, "Codex");
  assert.equal(provider.baseUrl, "https://api.openai.com/v1");
  assert.equal(provider.apiKey, "key");
  assert.equal(provider.requestFormat, "openai-responses");
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, false);
  assert.deepEqual(provider.activeModels, ["gpt-5"]);
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["gpt-5", "gpt-5-mini"],
  );
  assert.equal(provider.models[0].contextWindow, 258_000);
  assert.equal(provider.models[0].maxOutputToken, 142_000);
  assert.equal(provider.models[1].contextWindow, 64_000);
  assert.equal(provider.models[1].maxOutputToken, 4_096);
});

test("claude provider normalization defaults routing, caching, and model limits", () => {
  const provider = settings.normalizeCustomProvider({
    id: "claude-1",
    type: "claude_code",
    baseUrl: " https://api.anthropic.com/v1/ ",
    models: [{ model: "claude-sonnet" }],
    activeModels: ["claude-sonnet"],
    promptCachingEnabled: undefined,
  });

  assert.equal(provider.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, true);
  assert.equal(provider.nativeWebSearchEnabled, true);
  assert.equal(provider.models[0].contextWindow, 200_000);
  assert.equal(provider.models[0].maxOutputToken, 32_000);
});

test("gemini provider normalization keeps native routing and model limits", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gemini-1",
    name: " Gemini ",
    type: "gemini",
    baseUrl: " https://generativelanguage.googleapis.com/v1beta/ ",
    apiKey: " key ",
    models: [{ model: "gemini-3.5-flash" }],
    activeModels: ["gemini-3.5-flash"],
    requestFormat: "openai-responses",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: false,
  });

  assert.equal(provider.name, "Gemini");
  assert.equal(provider.type, "gemini");
  assert.equal(provider.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(provider.apiKey, "key");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, false);
  assert.deepEqual(provider.activeModels, ["gemini-3.5-flash"]);
  assert.equal(provider.models[0].contextWindow, 1_048_576);
  assert.equal(provider.models[0].maxOutputToken, 65_536);
});

test("settings normalization drops stale selected models and preserves valid selections", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5"],
      activeModels: ["gpt-5"],
    },
  ];

  const stale = settings.normalizeSettings({
    customProviders,
    selectedModel: { customProviderId: "provider-1", model: "missing" },
  });
  assert.equal(stale.selectedModel, undefined);

  const valid = settings.normalizeSettings({
    customProviders,
    selectedModel: { customProviderId: "provider-1", model: "gpt-5" },
  });
  assert.deepEqual(valid.selectedModel, { customProviderId: "provider-1", model: "gpt-5" });
});

test("custom settings conversation title model only keeps enabled provider models", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5", "gpt-5-mini"],
      activeModels: ["gpt-5-mini"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5-mini" },
    },
  });
  assert.deepEqual(normalized.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5-mini",
  });

  const stale = settings.normalizeSettings({
    customProviders,
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5" },
    },
  });
  assert.equal(stale.customSettings.conversationTitleModel, undefined);

  const cleared = settings.updateCustomSettings(normalized, {
    conversationTitleModel: undefined,
  });
  assert.equal(cleared.customSettings.conversationTitleModel, undefined);
});

test("chat runtime controls default and follow provider reasoning support", () => {
  const defaults = settings.getDefaultSettings();
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

  const normalized = settings.normalizeSettings({
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "invalid",
    },
  });
  assert.deepEqual(normalized.chatRuntimeControls, {
    thinkingEnabled: false,
    nativeWebSearchEnabled: false,
    reasoning: "high",
    reasoningByProvider: {
      claude_code: "high",
      codex_openai_responses: "high",
      codex_openai_completions: "high",
      gemini: "high",
    },
  });
});

test("memory model settings only keep enabled provider models", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5", "gpt-5.4"],
      activeModels: ["gpt-5"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      summaryModel: { customProviderId: "provider-1", model: "gpt-5.4" },
    },
  });

  assert.deepEqual(normalized.memory.organizerModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
  assert.equal(normalized.memory.summaryModel, undefined);

  const updated = settings.updateMemorySettings(normalized, {
    organizerModel: undefined,
    summaryModel: { customProviderId: "provider-1", model: "gpt-5" },
  });
  assert.equal(updated.memory.organizerModel, undefined);
  assert.deepEqual(updated.memory.summaryModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
});

test("memory organizer settings normalize schedule and disable stale enabled state", () => {
  const defaults = settings.getDefaultSettings();
  assert.equal(defaults.memory.organizerSchedule.frequency, "none");
  assert.equal(defaults.memory.organizerEnabled, false);
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(defaults.memory.organizerSchedule),
    undefined,
  );

  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5"],
      activeModels: ["gpt-5"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      organizerEnabled: true,
      organizerSchedule: {
        frequency: "weekly",
        timeLocal: "25:99",
        weekday: 9,
        timezone: "",
      },
      organizerScope: "projects",
      organizerMode: "aggressive",
    },
  });

  assert.equal(normalized.memory.organizerEnabled, true);
  assert.equal(normalized.memory.organizerSchedule.frequency, "weekly");
  assert.equal(normalized.memory.organizerSchedule.timeLocal, "03:00");
  assert.equal(normalized.memory.organizerSchedule.weekday, 1);
  assert.equal(typeof normalized.memory.organizerSchedule.timezone, "string");
  assert.equal(normalized.memory.organizerScope, "projects");
  assert.equal(normalized.memory.organizerMode, "aggressive");
  assert.equal(typeof normalized.memory.organizerNextRunAt, "number");

  const stale = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "missing" },
      organizerEnabled: true,
      organizerNextRunAt: 123,
    },
  });

  assert.equal(stale.memory.organizerModel, undefined);
  assert.equal(stale.memory.organizerEnabled, false);
  assert.equal(stale.memory.organizerNextRunAt, undefined);

  const disabledSchedule = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      organizerEnabled: true,
      organizerSchedule: {
        frequency: "none",
      },
      organizerNextRunAt: 123,
    },
  });

  assert.equal(disabledSchedule.memory.organizerSchedule.frequency, "none");
  assert.equal(disabledSchedule.memory.organizerEnabled, false);
  assert.equal(disabledSchedule.memory.organizerNextRunAt, undefined);
});

test("gateway settings sync payload redacts provider api keys", () => {
  const appSettings = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "low",
      reasoningByProvider: {
        claude_code: "low",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "minimal",
      },
    },
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5" },
      projectToolsPanel: {
        width: 612,
        activeTab: "tunnel",
        activeTabs: {
          " /workspace/a ": "tunnel",
          "/workspace/b": "gitReview",
          " ": "terminal",
        },
        tabOrders: {
          "/workspace/a": ["__tunnel__", "__file_tree__"],
        },
      },
      projectToolsFileTree: {
        openProjectPathKeys: ["/workspace/b", "  ", "/workspace/a", "/workspace/a"],
        projects: {
          "/workspace/a": {
            query: "src",
            selectedPath: "src/main.ts",
            expandedPaths: ["", "src", "src/../bad", "src"],
            revision: 3,
          },
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/b", "/workspace/a", "/workspace/a"],
        openVersion: 2,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/b", "/workspace/a", "/workspace/a"],
        openVersion: 3,
      },
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings);
  assert.equal(payload.customProviders[0].apiKey, undefined);
  assert.equal(payload.customProviders[0].apiKeyConfigured, true);
  assert.equal(payload.customProviders[0].nativeWebSearchEnabled, true);
  assert.deepEqual(payload.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
  assert.deepEqual(payload.customSettings.chatSidebar, {
    projectsCollapsed: false,
    recentCollapsed: false,
  });
  assert.deepEqual(payload.customSettings.projectToolsFileTree, {
    openProjectPathKeys: ["/workspace/a", "/workspace/b"],
    openVersion: 0,
    projects: {
      "/workspace/a": {
        query: "src",
        selectedPath: "src/main.ts",
        expandedPaths: ["", "src", "src/bad"],
        revision: 3,
        stateVersion: 0,
      },
    },
  });
  assert.deepEqual(payload.customSettings.projectToolsGitReview, {
    openProjectPathKeys: ["/workspace/a", "/workspace/b"],
    openVersion: 2,
  });
  assert.deepEqual(payload.customSettings.projectToolsTunnel, {
    openProjectPathKeys: ["/workspace/a", "/workspace/b"],
    openVersion: 3,
  });
  assert.equal(Object.hasOwn(payload.customSettings, "projectToolsPanel"), false);
  assert.deepEqual(payload.chatRuntimeControls, appSettings.chatRuntimeControls);
  assert.equal(payload.providerApiKeyUpdates, undefined);

  const updatePayload = sync.buildGatewaySettingsSyncPayload(appSettings, {
    includeProviderApiKeyUpdates: true,
  });
  assert.equal(updatePayload.customProviders[0].apiKey, undefined);
  assert.deepEqual(updatePayload.providerApiKeyUpdates, {
    "provider-1": "secret-key",
  });
});

test("gateway settings sync redacts ssh secrets and preserves configured state", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          port: 2222,
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
          privateKeyPath: "~/.ssh/id_ed25519",
          privateKeyPassphrase: "key-passphrase",
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
        "/workspace/project": ["prod", "missing", "prod"],
      },
    },
    remote: {
      enableWebTerminal: true,
      enableWebSshTerminal: true,
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings);
  assert.equal(payload.ssh.hosts[0].password, "");
  assert.equal(payload.ssh.hosts[0].privateKey, "");
  assert.equal(payload.ssh.hosts[0].privateKeyPassphrase, "");
  assert.equal(payload.ssh.hosts[0].proxy.password, "");
  assert.equal(payload.ssh.hosts[0].passwordConfigured, true);
  assert.equal(payload.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(payload.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.equal(payload.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.deepEqual(payload.ssh.projectHostAssociations, {
    "/workspace/project": ["prod"],
  });
  assert.equal(payload.sshSecretUpdates, undefined);
  assert.deepEqual(payload.remote, {
    enableWebTerminal: true,
    enableWebSshTerminal: true,
    enableWebGit: false,
    enableWebTunnels: false,
  });

  const updatePayload = sync.buildGatewaySettingsSyncPayload(appSettings, {
    includeProviderApiKeyUpdates: true,
  });
  assert.deepEqual(updatePayload.sshSecretUpdates, {
    prod: {
      password: "ssh-password",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
      privateKeyPassphrase: "key-passphrase",
      proxyPassword: "proxy-password",
    },
  });
});

test("workspace project selection does not rewrite global system workdir or sync active project", () => {
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

  const payload = sync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
  );
  assert.equal(Object.hasOwn(payload.system, "activeWorkspaceProjectId"), false);
  assert.equal(payload.system.workdir, "/default-workdir");

  const synced = sync.applyGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
    payload,
  );
  assert.equal(synced.system.activeWorkspaceProjectId, "project-a");
});

test("gateway settings sync preserves active workspace project by path when ids differ", () => {
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
  const incoming = sync.buildGatewaySettingsSyncPayload(
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

  const synced = sync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(synced.system.activeWorkspaceProjectId, "desktop-project-a");
});

test("normalizes project tools panel from current settings", () => {
  const currentShape = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        width: 544,
        activeTab: "terminal",
        activeTabs: {
          " /workspace/app ": "gitReview",
          "/workspace/other": "invalid",
          " ": "terminal",
        },
        tabOrders: {
          " /workspace/app ": [
            "terminal-2",
            "",
            "terminal-1",
            "terminal-2",
            "x".repeat(200),
            "__file_tree__",
          ],
          " ": ["ignored"],
        },
      },
    },
  });

  assert.equal(currentShape.customSettings.projectToolsPanel.width, 544);
  assert.equal(currentShape.customSettings.projectToolsPanel.activeTab, "terminal");
  assert.deepEqual(currentShape.customSettings.projectToolsPanel.activeTabs, {
    "/workspace/app": "gitReview",
  });
  assert.deepEqual(currentShape.customSettings.projectToolsPanel.tabOrders, {
    "/workspace/app": ["terminal-2", "terminal-1", "__file_tree__"],
  });
});

test("updates project tools panel active tab per project", () => {
  const base = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        activeTab: "terminal",
      },
    },
  });
  const updated = settings.updateProjectToolsPanelActiveTab(base, "/workspace/app", "gitReview");

  assert.equal(updated.customSettings.projectToolsPanel.activeTab, "gitReview");
  assert.equal(
    settings.getProjectToolsPanelActiveTab(updated.customSettings, "/workspace/app"),
    "gitReview",
  );
  assert.equal(
    settings.getProjectToolsPanelActiveTab(updated.customSettings, "/workspace/other"),
    "gitReview",
  );
  assert.deepEqual(updated.customSettings.projectToolsPanel.activeTabs, {
    "/workspace/app": "gitReview",
  });
});

test("updates project tools panel tab order per project", () => {
  const base = settings.normalizeSettings({});
  const updated = settings.updateProjectToolsPanelTabOrder(base, "/workspace/app", [
    "terminal-2",
    "terminal-1",
    "terminal-2",
    "__file_tree__",
  ]);

  assert.deepEqual(settings.getProjectToolsPanelTabOrder(updated.customSettings, "/workspace/app"), [
    "terminal-2",
    "terminal-1",
    "__file_tree__",
  ]);

  const cleared = settings.updateProjectToolsPanelTabOrder(updated, "/workspace/app", []);
  assert.deepEqual(settings.getProjectToolsPanelTabOrder(cleared.customSettings, "/workspace/app"), []);
});

test("updates project file tree synced state per project", () => {
  const base = settings.normalizeSettings({});
  const updated = settings.updateProjectToolsFileTreeProjectState(base, "/workspace/app", {
    query: "x".repeat(250),
    selectedPath: "src/../main.ts",
    expandedPaths: ["", "src", "src/../bad", "src\\components", "src"],
    bumpRevision: true,
    bumpStateVersion: true,
  });

  assert.deepEqual(updated.customSettings.projectToolsFileTree.projects["/workspace/app"], {
    query: "x".repeat(200),
    selectedPath: "src/main.ts",
    expandedPaths: ["", "src", "src/bad", "src/components"],
    revision: 1,
    stateVersion: 1,
  });

  const reopened = settings.updateProjectToolsFileTreeOpen(updated, "/workspace/app", true);
  assert.deepEqual(reopened.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.equal(reopened.customSettings.projectToolsFileTree.openVersion, 1);
  assert.equal(
    settings.getProjectToolsFileTreeProjectState(reopened.customSettings, "/workspace/app")
      .revision,
    1,
  );
});

test("settings reload preserves session-only project tools state", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        width: 544,
        activeTab: "gitReview",
      },
      projectToolsFileTree: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 4,
        projects: {
          "/workspace/app": {
            query: "src",
            selectedPath: "src/main.ts",
            expandedPaths: ["", "src"],
            revision: 2,
            stateVersion: 6,
          },
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 5,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 6,
      },
    },
  });
  const reloaded = settings.normalizeSettings({
    locale: "en-US",
    customSettings: {
      projectToolsPanel: {
        width: 720,
        activeTab: "terminal",
        tabOrders: {
          "/workspace/app": ["terminal-1"],
        },
      },
      projectToolsFileTree: {},
      projectToolsGitReview: {},
      projectToolsTunnel: {},
    },
  });

  const merged = settings.preserveProjectToolsSessionState(reloaded, current);

  assert.equal(merged.locale, "en-US");
  assert.equal(merged.customSettings.projectToolsPanel.width, 720);
  assert.equal(merged.customSettings.projectToolsPanel.activeTab, "terminal");
  assert.deepEqual(merged.customSettings.projectToolsPanel.tabOrders, {
    "/workspace/app": ["terminal-1"],
  });
  assert.deepEqual(merged.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.deepEqual(merged.customSettings.projectToolsFileTree.projects["/workspace/app"], {
    query: "src",
    selectedPath: "src/main.ts",
    expandedPaths: ["", "src"],
    revision: 2,
    stateVersion: 6,
  });
  assert.deepEqual(merged.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.equal(merged.customSettings.projectToolsGitReview.openVersion, 5);
  assert.deepEqual(merged.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.equal(merged.customSettings.projectToolsTunnel.openVersion, 6);

  const loadedWithProjectTools = settings.normalizeSettings({
    customSettings: {
      projectToolsFileTree: {
        openProjectPathKeys: ["/loaded/project"],
        openVersion: 1,
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/loaded/project"],
        openVersion: 1,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/loaded/project"],
        openVersion: 1,
      },
    },
  });
  const emptyCurrent = settings.normalizeSettings({});
  const loadedOnly = settings.preserveProjectToolsSessionState(
    loadedWithProjectTools,
    emptyCurrent,
  );

  assert.deepEqual(loadedOnly.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/loaded/project",
  ]);
  assert.deepEqual(loadedOnly.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/loaded/project",
  ]);
  assert.deepEqual(loadedOnly.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/loaded/project",
  ]);
});

test("removes project tools state when a workspace project is deleted", () => {
  const base = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        activeTab: "fileTree",
        activeTabs: {
          "/workspace/app": "fileTree",
          "/workspace/other": "gitReview",
        },
        tabOrders: {
          "/workspace/app": ["terminal-a", "__file_tree__"],
          "/workspace/other": ["terminal-b"],
        },
      },
      projectToolsFileTree: {
        openProjectPathKeys: ["/workspace/app", "/workspace/other"],
        openVersion: 3,
        projects: {
          "/workspace/app": {
            query: "src",
            selectedPath: "src/main.ts",
            expandedPaths: ["", "src"],
            revision: 2,
            stateVersion: 4,
          },
          "/workspace/other": {
            query: "lib",
            selectedPath: "lib/index.ts",
            expandedPaths: ["", "lib"],
            revision: 1,
            stateVersion: 1,
          },
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/app", "/workspace/other"],
        openVersion: 5,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/app", "/workspace/other"],
        openVersion: 6,
      },
    },
  });

  const cleaned = settings.removeProjectToolsProjectState(base, "/workspace/app");

  assert.deepEqual(cleaned.customSettings.projectToolsPanel.activeTabs, {
    "/workspace/other": "gitReview",
  });
  assert.deepEqual(cleaned.customSettings.projectToolsPanel.tabOrders, {
    "/workspace/other": ["terminal-b"],
  });
  assert.deepEqual(cleaned.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/workspace/other",
  ]);
  assert.equal(cleaned.customSettings.projectToolsFileTree.openVersion, 4);
  assert.deepEqual(Object.keys(cleaned.customSettings.projectToolsFileTree.projects), [
    "/workspace/other",
  ]);
  assert.deepEqual(cleaned.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/workspace/other",
  ]);
  assert.equal(cleaned.customSettings.projectToolsGitReview.openVersion, 6);
  assert.deepEqual(cleaned.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/workspace/other",
  ]);
  assert.equal(cleaned.customSettings.projectToolsTunnel.openVersion, 7);
  assert.equal(settings.removeProjectToolsProjectState(cleaned, "/workspace/app"), cleaned);

  const projectOnlyState = settings.normalizeSettings({
    customSettings: {
      projectToolsFileTree: {
        openVersion: 7,
        projects: {
          "/workspace/app": {
            query: "src",
            selectedPath: "src/main.ts",
            expandedPaths: ["", "src"],
            stateVersion: 2,
          },
        },
      },
    },
  });
  const projectOnlyCleaned = settings.removeProjectToolsProjectState(
    projectOnlyState,
    "/workspace/app",
  );
  assert.equal(projectOnlyCleaned.customSettings.projectToolsFileTree.openVersion, 8);
  assert.deepEqual(projectOnlyCleaned.customSettings.projectToolsFileTree.projects, {});

  const gitReviewOnlyState = settings.normalizeSettings({
    customSettings: {
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 9,
      },
    },
  });
  const gitReviewOnlyCleaned = settings.removeProjectToolsProjectState(
    gitReviewOnlyState,
    "/workspace/app",
  );
  assert.equal(gitReviewOnlyCleaned.customSettings.projectToolsGitReview.openVersion, 10);
  assert.deepEqual(gitReviewOnlyCleaned.customSettings.projectToolsGitReview.openProjectPathKeys, []);

  const tunnelOnlyState = settings.normalizeSettings({
    customSettings: {
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 11,
      },
    },
  });
  const tunnelOnlyCleaned = settings.removeProjectToolsProjectState(
    tunnelOnlyState,
    "/workspace/app",
  );
  assert.equal(tunnelOnlyCleaned.customSettings.projectToolsTunnel.openVersion, 12);
  assert.deepEqual(tunnelOnlyCleaned.customSettings.projectToolsTunnel.openProjectPathKeys, []);
});

test("gateway settings sync keeps project tools panel local and syncs project tool state", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        width: 612,
        activeTab: "terminal",
        activeTabs: {
          "/desktop/project": "terminal",
        },
        tabOrders: {
          "/desktop/project": ["desktop-terminal", "__file_tree__"],
        },
      },
      projectToolsFileTree: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 1,
        projects: {
          "/desktop/project": {
            query: "desktop",
            selectedPath: "desktop.ts",
            expandedPaths: ["", "src"],
            revision: 1,
          },
        },
      },
      projectToolsGitReview: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 1,
      },
      projectToolsTunnel: {
        openProjectPathKeys: ["/desktop/project"],
        openVersion: 1,
      },
    },
  });
  const incoming = settings.normalizeSettings({
    customSettings: {
      projectToolsPanel: {
        width: 360,
        activeTab: "fileTree",
        activeTabs: {
          "/web/project": "fileTree",
        },
        tabOrders: {
          "/web/project": ["web-terminal", "__file_tree__"],
        },
      },
      projectToolsFileTree: {
        openProjectPathKeys: ["/web/project"],
        openVersion: 2,
        projects: {
          "/web/project": {
            query: "web",
            selectedPath: "web.ts",
            expandedPaths: ["", "packages"],
            revision: 2,
          },
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
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(incoming);
  assert.equal(Object.hasOwn(payload.customSettings, "projectToolsPanel"), false);

  const synced = sync.applyGatewaySettingsSyncPayload(current, payload);

  assert.equal(synced.customSettings.projectToolsPanel.width, 612);
  assert.equal(synced.customSettings.projectToolsPanel.activeTab, "terminal");
  assert.deepEqual(synced.customSettings.projectToolsPanel.activeTabs, {
    "/desktop/project": "terminal",
  });
  assert.deepEqual(synced.customSettings.projectToolsPanel.tabOrders, {
    "/desktop/project": ["desktop-terminal", "__file_tree__"],
  });
  assert.deepEqual(synced.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.deepEqual(synced.customSettings.projectToolsFileTree.projects["/web/project"], {
    query: "web",
    selectedPath: "web.ts",
    expandedPaths: ["", "packages"],
    revision: 2,
    stateVersion: 0,
  });
  assert.deepEqual(synced.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.equal(synced.customSettings.projectToolsGitReview.openVersion, 2);
  assert.deepEqual(synced.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/web/project",
  ]);
  assert.equal(synced.customSettings.projectToolsTunnel.openVersion, 2);
});

test("gateway settings sync ignores stale project file tree UI snapshots", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsFileTree: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 2,
        projects: {
          "/workspace/app": {
            query: "",
            selectedPath: "default-project/test",
            expandedPaths: ["", "default-project", "default-project/test"],
            revision: 1,
            stateVersion: 3,
          },
        },
      },
    },
  });

  const staleSynced = sync.applyGatewaySettingsSyncPayload(current, {
    customSettings: {
      projectToolsFileTree: {
        openProjectPathKeys: [],
        openVersion: 1,
        projects: {
          "/workspace/app": {
            query: "",
            selectedPath: "default-project/test",
            expandedPaths: ["", "default-project"],
            revision: 5,
            stateVersion: 2,
          },
        },
      },
    },
  });

  assert.deepEqual(staleSynced.customSettings.projectToolsFileTree.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.deepEqual(staleSynced.customSettings.projectToolsFileTree.projects["/workspace/app"], {
    query: "",
    selectedPath: "default-project/test",
    expandedPaths: ["", "default-project", "default-project/test"],
    revision: 5,
    stateVersion: 3,
  });

  const newerSynced = sync.applyGatewaySettingsSyncPayload(staleSynced, {
    customSettings: {
      projectToolsFileTree: {
        openProjectPathKeys: [],
        openVersion: 3,
        projects: {
          "/workspace/app": {
            query: "",
            selectedPath: "default-project/test",
            expandedPaths: ["", "default-project"],
            revision: 5,
            stateVersion: 4,
          },
        },
      },
    },
  });

  assert.deepEqual(newerSynced.customSettings.projectToolsFileTree.openProjectPathKeys, []);
  assert.deepEqual(newerSynced.customSettings.projectToolsFileTree.projects["/workspace/app"], {
    query: "",
    selectedPath: "default-project/test",
    expandedPaths: ["", "default-project"],
    revision: 5,
    stateVersion: 4,
  });

  const deletedProjectLocal = settings.removeProjectToolsProjectState(
    settings.normalizeSettings({
      customSettings: {
        projectToolsFileTree: {
          openProjectPathKeys: ["/workspace/deleted"],
          openVersion: 4,
          projects: {
            "/workspace/deleted": {
              query: "old",
              selectedPath: "src/old.ts",
              expandedPaths: ["", "src"],
              revision: 1,
              stateVersion: 1,
            },
          },
        },
      },
    }),
    "/workspace/deleted",
  );
  const deletedProjectSynced = sync.applyGatewaySettingsSyncPayload(deletedProjectLocal, {
    customSettings: {
      projectToolsFileTree: {
        openProjectPathKeys: ["/workspace/deleted"],
        openVersion: 4,
        projects: {
          "/workspace/deleted": {
            query: "old",
            selectedPath: "src/old.ts",
            expandedPaths: ["", "src"],
            revision: 1,
            stateVersion: 1,
          },
        },
      },
    },
  });
  assert.deepEqual(deletedProjectSynced.customSettings.projectToolsFileTree.openProjectPathKeys, []);
  assert.deepEqual(deletedProjectSynced.customSettings.projectToolsFileTree.projects, {});
});

test("gateway settings sync ignores stale project git review open snapshots", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 2,
      },
    },
  });

  const staleSynced = sync.applyGatewaySettingsSyncPayload(current, {
    customSettings: {
      projectToolsGitReview: {
        openProjectPathKeys: [],
        openVersion: 1,
      },
    },
  });

  assert.deepEqual(staleSynced.customSettings.projectToolsGitReview.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.equal(staleSynced.customSettings.projectToolsGitReview.openVersion, 2);

  const newerSynced = sync.applyGatewaySettingsSyncPayload(staleSynced, {
    customSettings: {
      projectToolsGitReview: {
        openProjectPathKeys: [],
        openVersion: 3,
      },
    },
  });

  assert.deepEqual(newerSynced.customSettings.projectToolsGitReview.openProjectPathKeys, []);
  assert.equal(newerSynced.customSettings.projectToolsGitReview.openVersion, 3);

  const deletedProjectLocal = settings.removeProjectToolsProjectState(
    settings.normalizeSettings({
      customSettings: {
        projectToolsGitReview: {
          openProjectPathKeys: ["/workspace/deleted"],
          openVersion: 4,
        },
      },
    }),
    "/workspace/deleted",
  );
  const deletedProjectSynced = sync.applyGatewaySettingsSyncPayload(deletedProjectLocal, {
    customSettings: {
      projectToolsGitReview: {
        openProjectPathKeys: ["/workspace/deleted"],
        openVersion: 4,
      },
    },
  });
  assert.deepEqual(deletedProjectSynced.customSettings.projectToolsGitReview.openProjectPathKeys, []);
  assert.equal(deletedProjectSynced.customSettings.projectToolsGitReview.openVersion, 5);
});

test("gateway settings sync ignores stale project tunnel open snapshots", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/app"],
        openVersion: 2,
      },
    },
  });

  const staleSynced = sync.applyGatewaySettingsSyncPayload(current, {
    customSettings: {
      projectToolsTunnel: {
        openProjectPathKeys: [],
        openVersion: 1,
      },
    },
  });

  assert.deepEqual(staleSynced.customSettings.projectToolsTunnel.openProjectPathKeys, [
    "/workspace/app",
  ]);
  assert.equal(staleSynced.customSettings.projectToolsTunnel.openVersion, 2);

  const newerSynced = sync.applyGatewaySettingsSyncPayload(staleSynced, {
    customSettings: {
      projectToolsTunnel: {
        openProjectPathKeys: [],
        openVersion: 3,
      },
    },
  });

  assert.deepEqual(newerSynced.customSettings.projectToolsTunnel.openProjectPathKeys, []);
  assert.equal(newerSynced.customSettings.projectToolsTunnel.openVersion, 3);

  const deletedProjectLocal = settings.removeProjectToolsProjectState(
    settings.normalizeSettings({
      customSettings: {
        projectToolsTunnel: {
          openProjectPathKeys: ["/workspace/deleted"],
          openVersion: 4,
        },
      },
    }),
    "/workspace/deleted",
  );
  const deletedProjectSynced = sync.applyGatewaySettingsSyncPayload(deletedProjectLocal, {
    customSettings: {
      projectToolsTunnel: {
        openProjectPathKeys: ["/workspace/deleted"],
        openVersion: 4,
      },
    },
  });
  assert.deepEqual(deletedProjectSynced.customSettings.projectToolsTunnel.openProjectPathKeys, []);
  assert.equal(deletedProjectSynced.customSettings.projectToolsTunnel.openVersion, 5);
});

test("gateway settings sync keeps newer project conversation activity", () => {
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
  const incoming = sync.buildGatewaySettingsSyncPayload(
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

  const synced = sync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(
    synced.system.workspaceProjects.find((item) => item.id === "project-a")?.lastConversationAt,
    1_700_000_000_900,
  );
});

test("gateway settings sync applies redacted providers without clearing local api keys", () => {
  const current = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "old-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
  });

  const redacted = sync.applyGatewaySettingsSyncPayload(current, {
    customProviders: [
      {
        id: "provider-1",
        name: "Renamed",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKeyConfigured: true,
        nativeWebSearchEnabled: false,
        models: ["gpt-5.4"],
        activeModels: ["gpt-5.4"],
      },
    ],
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "xhigh",
      },
    },
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5.4" },
    },
  });
  assert.equal(redacted.customProviders[0].name, "Renamed");
  assert.equal(redacted.customProviders[0].apiKey, "old-key");
  assert.equal(redacted.customProviders[0].nativeWebSearchEnabled, false);
  assert.equal(redacted.chatRuntimeControls.thinkingEnabled, false);
  assert.equal(redacted.chatRuntimeControls.nativeWebSearchEnabled, false);
  assert.equal(redacted.chatRuntimeControls.reasoning, "xhigh");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.claude_code, "xhigh");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.codex_openai_responses, "minimal");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.gemini, "high");
  assert.deepEqual(redacted.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5.4",
  });

  const updated = sync.applyGatewaySettingsSyncPayload(current, {
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKeyConfigured: true,
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
    providerApiKeyUpdates: {
      "provider-1": "new-key",
    },
  });
  assert.equal(updated.customProviders[0].apiKey, "new-key");
});

test("gateway settings sync applies redacted ssh hosts without clearing local secrets", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "old-password",
          privateKey: "old-key",
          privateKeyPassphrase: "old-passphrase",
          proxy: {
            password: "old-proxy-password",
          },
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
      },
    },
  });

  const redacted = sync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Renamed Production",
          host: "prod.internal",
          username: "ubuntu",
          authType: "privateKey",
          passwordConfigured: true,
          privateKeyConfigured: true,
          privateKeyPassphraseConfigured: true,
          proxy: {
            passwordConfigured: true,
          },
        },
      ],
      projectHostAssociations: {
        "/workspace/other": ["prod"],
      },
    },
  });
  assert.equal(redacted.ssh.hosts[0].name, "Renamed Production");
  assert.equal(redacted.ssh.hosts[0].password, "old-password");
  assert.equal(redacted.ssh.hosts[0].privateKey, "old-key");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphrase, "old-passphrase");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "old-proxy-password");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.deepEqual(redacted.ssh.projectHostAssociations, {
    "/workspace/other": ["prod"],
  });

  const updated = sync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          passwordConfigured: true,
          privateKeyConfigured: true,
          privateKeyPassphraseConfigured: true,
          proxy: {
            passwordConfigured: true,
          },
        },
      ],
    },
    sshSecretUpdates: {
      prod: {
        password: "new-password",
        privateKey: "new-key",
        privateKeyPassphrase: "new-passphrase",
        proxyPassword: "new-proxy-password",
      },
    },
  });
  assert.equal(updated.ssh.hosts[0].password, "new-password");
  assert.equal(updated.ssh.hosts[0].privateKey, "new-key");
  assert.equal(updated.ssh.hosts[0].privateKeyPassphrase, "new-passphrase");
  assert.equal(updated.ssh.hosts[0].proxy.password, "new-proxy-password");
});

test("gateway settings update payload omits unchanged empty ssh hosts for non-ssh updates", () => {
  const desktop = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
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
  const nextWeb = settings.updateProjectToolsSshTunnelOpen(staleWeb, "/workspace/project", true);

  const update = sync.buildGatewaySettingsSyncUpdatePayload(staleWeb, nextWeb, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(Object.hasOwn(update, "customSettings"), true);

  const merged = sync.applyGatewaySettingsSyncPayload(desktop, update);
  assert.deepEqual(
    merged.ssh.hosts.map((host) => host.id),
    ["prod"],
  );
  assert.deepEqual(merged.ssh.projectHostAssociations, {
    "/workspace/project": ["prod"],
  });
  assert.equal(settings.isProjectToolsSshTunnelOpen(merged.customSettings, "/workspace/project"), true);
});

test("gateway settings update payload includes ssh when hosts are explicitly deleted", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
      },
    },
  });
  const deleted = settings.updateSsh(current, {
    hosts: [],
    projectHostAssociations: {},
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, deleted, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), true);
  assert.deepEqual(update.ssh.hosts, []);
  assert.deepEqual(update.ssh.projectHostAssociations, {});
});

test("gateway settings update payload includes ssh for secret-only ssh updates", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
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

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), true);
  assert.deepEqual(update.sshSecretUpdates, {
    prod: {
      password: "new-password",
    },
  });

  const merged = sync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "new-password");
});

test("web storage redaction clears api keys but keeps configured state", () => {
  const appSettings = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
  });

  const redacted = sync.redactSettingsForWebStorage(appSettings);
  assert.equal(redacted.customProviders[0].apiKey, "");
  assert.equal(redacted.customProviders[0].apiKeyConfigured, true);
});

test("web storage redaction clears ssh secrets but keeps configured state", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "ssh-key",
          privateKeyPassphrase: "ssh-passphrase",
          proxy: {
            password: "proxy-password",
          },
        },
      ],
    },
  });

  const redacted = sync.redactSettingsForWebStorage(appSettings);
  assert.equal(redacted.ssh.hosts[0].password, "");
  assert.equal(redacted.ssh.hosts[0].privateKey, "");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphrase, "");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "");
  assert.equal(redacted.ssh.hosts[0].passwordConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.equal(redacted.ssh.hosts[0].proxy.passwordConfigured, true);
});

test("only one agent prompt template remains enabled after normalization", () => {
  const agents = settings.normalizeAgentPromptTemplates([
    { id: "a", name: "A", prompt: "Prompt A", enabled: true },
    { id: "b", name: "B", prompt: "Prompt B", enabled: true },
    { id: "c", name: "C", prompt: "Prompt C", enabled: false },
  ]);

  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.enabled]),
    [
      ["a", true],
      ["b", false],
      ["c", false],
    ],
  );
});

test("hook and cron normalization keep request bodies only for methods that support them", () => {
  const hook = settings.normalizeConversationHook({
    id: "hook-1",
    type: "http",
    event: "tool_execution_end",
    name: "Webhook",
    requests: [
      {
        id: "request-1",
        method: "get",
        url: " https://example.com ",
        headers: { " X-Test ": " yes ", empty: "" },
        body: { ignored: true },
      },
      {
        id: "request-2",
        method: "patch",
        url: "https://example.com/update",
        body: { kept: true },
      },
    ],
  });

  assert.equal(hook.event, "tool_execution_end");
  assert.equal(hook.requests[0].method, "GET");
  assert.equal(hook.requests[0].body, undefined);
  assert.deepEqual(hook.requests[0].headers, { "X-Test": "yes" });
  assert.deepEqual(hook.requests[1].body, { kept: true });

  const cronTask = settings.normalizeCronTask({
    id: "cron-1",
    type: "prompt",
    prompt: " Run daily ",
    selectedModel: { customProviderId: "p", model: "m" },
    script: "ignored",
  });
  assert.equal(cronTask.type, "prompt");
  assert.equal(cronTask.prompt, "Run daily");
  assert.deepEqual(cronTask.selectedModel, { customProviderId: "p", model: "m" });
  assert.equal(cronTask.script, undefined);

  const finiteCronTask = settings.normalizeCronTask({
    id: "cron-finite",
    type: "bash",
    script: "echo finite",
    remainingExecutions: "3",
  });
  assert.equal(finiteCronTask.remainingExecutions, 3);

  const exhaustedCronTask = settings.normalizeCronTask({
    id: "cron-exhausted",
    type: "bash",
    script: "echo exhausted",
    enabled: true,
    remainingExecutions: 0,
  });
  assert.equal(exhaustedCronTask.remainingExecutions, 0);
  assert.equal(exhaustedCronTask.enabled, false);

  const invalidCronTask = settings.normalizeCronTask({
    id: "cron-invalid",
    type: "bash",
    script: "echo invalid",
    remainingExecutions: -1,
  });
  assert.equal(invalidCronTask.remainingExecutions, undefined);
});

test("command hook normalization uses script only", () => {
  const scriptHook = settings.normalizeConversationHook({
    id: "hook-script",
    type: "command",
    event: "agent_end",
    name: "Script",
    script: " printf hook-ready ",
  });
  assert.equal(scriptHook.script, "printf hook-ready");
  assert.equal(scriptHook.commands, undefined);
});

test("mcp and remote settings normalize transport, selection, ports, and tokens", () => {
  const mcp = settings.normalizeMcpSettings({
    servers: [
      { id: "server-a", enabled: true, transport: "http", url: " https://mcp.example.com ", timeoutMs: "-1" },
      { id: "server-b", enabled: false, transport: "bad", command: " node ", args: [" server.js ", ""] },
    ],
    selected: ["server-b", "missing", "server-b", "server-a"],
  });

  assert.deepEqual(mcp.selected, ["server-b", "server-a"]);
  assert.equal(mcp.servers[0].transport, "http");
  assert.equal(mcp.servers[0].timeoutMs, 60_000);
  assert.equal(mcp.servers[1].transport, "stdio");
  assert.deepEqual(mcp.servers[1].args, ["server.js"]);

  const remote = settings.normalizeRemoteSettings({
    enabled: true,
    gatewayUrl: " http:/127.0.0.1:8787/ ",
    grpcPort: "0",
    grpcEndpoint: " tcp.proxy.rlwy.net:12345/ ",
    token: " secret ",
    autoReconnect: false,
    heartbeatInterval: "15.8",
    enableWebSshTerminal: true,
  });

  assert.equal(remote.gatewayUrl, "http://127.0.0.1:8787");
  assert.equal(remote.grpcPort, 50051);
  assert.equal(remote.grpcEndpoint, "tcp.proxy.rlwy.net:12345");
  assert.equal(remote.token, "secret");
  assert.equal(remote.autoReconnect, false);
  assert.equal(remote.heartbeatInterval, 15);
  assert.equal(remote.enableWebSshTerminal, true);

  const remoteWithOversizedPort = settings.normalizeRemoteSettings({
    grpcPort: "70000",
  });
  assert.equal(remoteWithOversizedPort.grpcPort, 65_535);
});
