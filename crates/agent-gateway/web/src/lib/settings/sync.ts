import {
  normalizeChatRuntimeControls,
  normalizeProjectToolsFileTreeSettings,
  normalizeProjectToolsGitReviewSettings,
  normalizeProjectToolsSshTunnelSettings,
  normalizeProjectToolsTunnelSettings,
  normalizeSettings,
  workspaceProjectPathKey,
  type AppSettings,
} from "./index";

export type GatewayProviderApiKeyUpdates = Record<string, string>;
export type GatewaySshSecretUpdates = Record<
  string,
  {
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
    proxyPassword?: string;
  }
>;
export type GatewaySettingsSyncProvider = Omit<AppSettings["customProviders"][number], "apiKey"> & {
  apiKeyConfigured?: boolean;
};
export type GatewaySettingsSyncCustomSettings = Omit<
  Partial<AppSettings["customSettings"]>,
  "projectToolsPanel"
>;

export type GatewaySettingsSyncPayload = {
  system: AppSettings["system"];
  customProviders: GatewaySettingsSyncProvider[];
  mcp: AppSettings["mcp"];
  agents: AppSettings["agents"];
  ssh: AppSettings["ssh"];
  hooks: AppSettings["hooks"];
  cron: AppSettings["cron"];
  remote?: Pick<
    AppSettings["remote"],
    "enableWebTerminal" | "enableWebSshTerminal" | "enableWebGit" | "enableWebTunnels"
  >;
  memory: AppSettings["memory"];
  customSettings: GatewaySettingsSyncCustomSettings;
  skills: AppSettings["skills"];
  chatRuntimeControls: AppSettings["chatRuntimeControls"];
  selectedModel: AppSettings["selectedModel"] | null;
  theme: AppSettings["theme"];
  locale: AppSettings["locale"];
  providerApiKeyUpdates?: GatewayProviderApiKeyUpdates;
  sshSecretUpdates?: GatewaySshSecretUpdates;
};
export type GatewaySettingsSyncUpdatePayload = Partial<GatewaySettingsSyncPayload>;

const GATEWAY_SETTINGS_SYNC_FIELDS = [
  "system",
  "customProviders",
  "mcp",
  "agents",
  "ssh",
  "hooks",
  "cron",
  "remote",
  "memory",
  "customSettings",
  "skills",
  "chatRuntimeControls",
  "selectedModel",
  "theme",
  "locale",
] as const satisfies readonly (keyof GatewaySettingsSyncPayload)[];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function apiKeyConfiguredForProvider(provider: AppSettings["customProviders"][number]) {
  return provider.apiKey.trim().length > 0 || provider.apiKeyConfigured === true;
}

export function redactCustomProvidersForGateway(
  customProviders: AppSettings["customProviders"],
): GatewaySettingsSyncProvider[] {
  return customProviders.map((provider) => {
    const { apiKey: _apiKey, ...rest } = provider;
    return {
      ...rest,
      apiKeyConfigured: apiKeyConfiguredForProvider(provider),
    };
  });
}

export function redactCustomProvidersForWebStorage(
  customProviders: AppSettings["customProviders"],
): AppSettings["customProviders"] {
  return customProviders.map((provider) => ({
    ...provider,
    apiKey: "",
    apiKeyConfigured: apiKeyConfiguredForProvider(provider),
  }));
}

export function redactSettingsForWebStorage(settings: AppSettings): AppSettings {
  return normalizeSettings({
    ...settings,
    customProviders: redactCustomProvidersForWebStorage(settings.customProviders),
    ssh: redactSshSettingsForWebStorage(settings.ssh),
  });
}

function redactSshSettingsForWebStorage(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return {
    projectHostAssociations: ssh.projectHostAssociations,
    hosts: ssh.hosts.map((host) => ({
      ...host,
      password: "",
      passwordConfigured: host.password.trim().length > 0 || host.passwordConfigured === true,
      privateKey: "",
      privateKeyConfigured:
        host.privateKey.trim().length > 0 ||
        host.privateKeyPath.trim().length > 0 ||
        host.privateKeyConfigured === true,
      privateKeyPassphrase: "",
      privateKeyPassphraseConfigured:
        host.privateKeyPassphrase.trim().length > 0 ||
        host.privateKeyPassphraseConfigured === true,
      proxy: {
        ...host.proxy,
        password: "",
        passwordConfigured:
          host.proxy.password.trim().length > 0 || host.proxy.passwordConfigured === true,
      },
    })),
  };
}

function collectProviderApiKeyUpdates(
  customProviders: AppSettings["customProviders"],
): GatewayProviderApiKeyUpdates | undefined {
  const updates: GatewayProviderApiKeyUpdates = {};
  for (const provider of customProviders) {
    const apiKey = provider.apiKey.trim();
    if (provider.id.trim() && apiKey) {
      updates[provider.id] = apiKey;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function collectSshSecretUpdates(ssh: AppSettings["ssh"]): GatewaySshSecretUpdates | undefined {
  const updates: GatewaySshSecretUpdates = {};
  for (const host of ssh.hosts) {
    const id = host.id.trim();
    if (!id) continue;
    const password = host.password.trim();
    const privateKey = host.privateKey.trim();
    const privateKeyPassphrase = host.privateKeyPassphrase.trim();
    const proxyPassword = host.proxy.password.trim();
    const update: GatewaySshSecretUpdates[string] = {};
    if (password) update.password = password;
    if (privateKey) update.privateKey = privateKey;
    if (privateKeyPassphrase) update.privateKeyPassphrase = privateKeyPassphrase;
    if (proxyPassword) update.proxyPassword = proxyPassword;
    if (Object.keys(update).length > 0) {
      updates[id] = update;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function redactSshSettingsForGateway(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return redactSshSettingsForWebStorage(ssh);
}

function syncableCustomSettings(
  customSettings: AppSettings["customSettings"],
): GatewaySettingsSyncCustomSettings {
  const { projectToolsPanel: _projectToolsPanel, ...syncable } = customSettings;
  return {
    ...syncable,
    chatSidebar: {
      projectsCollapsed: false,
      recentCollapsed: false,
    },
  };
}

function syncableSystemSettings(system: AppSettings["system"]): AppSettings["system"] {
  const syncableSystem = { ...system };
  delete syncableSystem.activeWorkspaceProjectId;
  return syncableSystem as AppSettings["system"];
}

function readWorkspaceProjectLastConversationAt(
  project: AppSettings["system"]["workspaceProjects"][number],
) {
  return typeof project.lastConversationAt === "number" &&
    Number.isFinite(project.lastConversationAt) &&
    project.lastConversationAt > 0
    ? project.lastConversationAt
    : 0;
}

function resolveSyncedActiveWorkspaceProjectId(
  current: AppSettings["system"],
  incomingSystem: AppSettings["system"],
) {
  const explicitActiveProjectId =
    typeof incomingSystem.activeWorkspaceProjectId === "string" &&
    incomingSystem.activeWorkspaceProjectId.trim()
      ? incomingSystem.activeWorkspaceProjectId.trim()
      : "";
  const currentActiveProjectId = current.activeWorkspaceProjectId?.trim() || "";
  const currentActiveProject = current.workspaceProjects.find(
    (project) => project.id === currentActiveProjectId,
  );
  const currentActivePathKey = workspaceProjectPathKey(currentActiveProject?.path ?? "");
  const incomingProjects = Array.isArray(incomingSystem.workspaceProjects)
    ? incomingSystem.workspaceProjects
    : [];

  if (
    explicitActiveProjectId &&
    incomingProjects.some((project) => project.id === explicitActiveProjectId)
  ) {
    return explicitActiveProjectId;
  }
  if (
    currentActiveProjectId &&
    incomingProjects.some((project) => project.id === currentActiveProjectId)
  ) {
    return currentActiveProjectId;
  }
  if (currentActivePathKey) {
    const matchingProject = incomingProjects.find(
      (project) => workspaceProjectPathKey(project.path) === currentActivePathKey,
    );
    if (matchingProject?.id?.trim()) {
      return matchingProject.id.trim();
    }
  }

  return explicitActiveProjectId || currentActiveProjectId;
}

function mergeSyncedSystemSettings(
  current: AppSettings["system"],
  incoming: unknown,
): AppSettings["system"] {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return current;
  }

  const incomingSystem = incoming as AppSettings["system"];
  const activeWorkspaceProjectId = resolveSyncedActiveWorkspaceProjectId(current, incomingSystem);
  if (!Array.isArray(incomingSystem.workspaceProjects)) {
    return {
      ...incomingSystem,
      activeWorkspaceProjectId,
    };
  }

  const currentActivityByPath = new Map<string, number>();
  for (const project of current.workspaceProjects) {
    const pathKey = workspaceProjectPathKey(project.path);
    const lastConversationAt = readWorkspaceProjectLastConversationAt(project);
    if (pathKey && lastConversationAt > 0) {
      currentActivityByPath.set(pathKey, lastConversationAt);
    }
  }

  return {
    ...incomingSystem,
    activeWorkspaceProjectId,
    workspaceProjects: incomingSystem.workspaceProjects.map((project) => {
      const lastConversationAt = Math.max(
        readWorkspaceProjectLastConversationAt(project),
        currentActivityByPath.get(workspaceProjectPathKey(project.path)) ?? 0,
      );
      return lastConversationAt > 0
        ? {
            ...project,
            lastConversationAt,
          }
        : project;
    }),
  };
}

function normalizeProviderApiKeyUpdates(value: unknown): GatewayProviderApiKeyUpdates {
  const source = asObject(value);
  const updates: GatewayProviderApiKeyUpdates = {};
  for (const [id, apiKey] of Object.entries(source)) {
    const normalizedId = id.trim();
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (normalizedId && normalizedApiKey) {
      updates[normalizedId] = normalizedApiKey;
    }
  }
  return updates;
}

function normalizeSshSecretUpdates(value: unknown): GatewaySshSecretUpdates {
  const source = asObject(value);
  const updates: GatewaySshSecretUpdates = {};
  for (const [id, rawUpdate] of Object.entries(source)) {
    const normalizedId = id.trim();
    if (!normalizedId) continue;
    const updateSource = asObject(rawUpdate);
    const password = typeof updateSource.password === "string" ? updateSource.password.trim() : "";
    const privateKey =
      typeof updateSource.privateKey === "string" ? updateSource.privateKey.trim() : "";
    const privateKeyPassphrase =
      typeof updateSource.privateKeyPassphrase === "string"
        ? updateSource.privateKeyPassphrase.trim()
        : "";
    const proxyPassword =
      typeof updateSource.proxyPassword === "string" ? updateSource.proxyPassword.trim() : "";
    const update: GatewaySshSecretUpdates[string] = {};
    if (password) update.password = password;
    if (privateKey) update.privateKey = privateKey;
    if (privateKeyPassphrase) update.privateKeyPassphrase = privateKeyPassphrase;
    if (proxyPassword) update.proxyPassword = proxyPassword;
    if (Object.keys(update).length > 0) {
      updates[normalizedId] = update;
    }
  }
  return updates;
}

function mergeSyncedCustomProviders(
  current: AppSettings["customProviders"],
  incoming: unknown,
  apiKeyUpdates: GatewayProviderApiKeyUpdates,
): AppSettings["customProviders"] {
  if (!Array.isArray(incoming)) {
    return current;
  }

  const currentById = new Map(current.map((provider) => [provider.id, provider]));
  return incoming.map((item) => {
    const source = asObject(item);
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const currentProvider = id ? currentById.get(id) : undefined;
    const apiKeyUpdate = id ? apiKeyUpdates[id] : undefined;
    const sourceApiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
    const apiKey = (apiKeyUpdate ?? sourceApiKey) || currentProvider?.apiKey || "";
    const sourceHasConfiguredFlag = Object.prototype.hasOwnProperty.call(
      source,
      "apiKeyConfigured",
    );

    return {
      ...source,
      apiKey,
      apiKeyConfigured:
        apiKey.length > 0 ||
        source.apiKeyConfigured === true ||
        (!sourceHasConfiguredFlag && currentProvider?.apiKeyConfigured === true),
    };
  }) as AppSettings["customProviders"];
}

function mergeSyncedRemoteSettings(
  current: AppSettings["remote"],
  incoming: unknown,
): AppSettings["remote"] {
  const source = asObject(incoming);
  if (
    !Object.prototype.hasOwnProperty.call(source, "enableWebTerminal") &&
    !Object.prototype.hasOwnProperty.call(source, "enableWebSshTerminal") &&
    !Object.prototype.hasOwnProperty.call(source, "enableWebGit") &&
    !Object.prototype.hasOwnProperty.call(source, "enableWebTunnels")
  ) {
    return current;
  }
  return {
    ...current,
    enableWebTerminal: Object.prototype.hasOwnProperty.call(source, "enableWebTerminal")
      ? source.enableWebTerminal === true
      : current.enableWebTerminal,
    enableWebSshTerminal: Object.prototype.hasOwnProperty.call(source, "enableWebSshTerminal")
      ? source.enableWebSshTerminal === true
      : current.enableWebSshTerminal,
    enableWebGit: Object.prototype.hasOwnProperty.call(source, "enableWebGit")
      ? source.enableWebGit === true
      : current.enableWebGit,
    enableWebTunnels: Object.prototype.hasOwnProperty.call(source, "enableWebTunnels")
      ? source.enableWebTunnels === true
      : current.enableWebTunnels,
  };
}

function mergeSyncedSshSettings(
  current: AppSettings["ssh"],
  incoming: unknown,
  secretUpdates: GatewaySshSecretUpdates,
): AppSettings["ssh"] {
  const source = asObject(incoming);
  const normalized = normalizeSettings({
    ssh: incoming as AppSettings["ssh"],
  }).ssh;
  const currentById = new Map(current.hosts.map((host) => [host.id, host]));
  const projectHostAssociations = Object.prototype.hasOwnProperty.call(
    source,
    "projectHostAssociations",
  )
    ? normalized.projectHostAssociations
    : normalizeSettings({
        ssh: {
          hosts: normalized.hosts,
          projectHostAssociations: current.projectHostAssociations,
        },
      }).ssh.projectHostAssociations;
  return {
    projectHostAssociations,
    hosts: normalized.hosts.map((host) => {
      const currentHost = currentById.get(host.id);
      const update = secretUpdates[host.id];
      const password = (update?.password ?? host.password.trim()) || currentHost?.password || "";
      const privateKey =
        (update?.privateKey ?? host.privateKey.trim()) || currentHost?.privateKey || "";
      const privateKeyPassphrase =
        (update?.privateKeyPassphrase ?? host.privateKeyPassphrase.trim()) ||
        currentHost?.privateKeyPassphrase ||
        "";
      const proxyPassword =
        (update?.proxyPassword ?? host.proxy.password.trim()) || currentHost?.proxy.password || "";
      return {
        ...host,
        password,
        passwordConfigured:
          password.length > 0 ||
          host.passwordConfigured === true ||
          currentHost?.passwordConfigured === true,
        privateKey,
        privateKeyConfigured:
          privateKey.length > 0 ||
          host.privateKeyPath.trim().length > 0 ||
          host.privateKeyConfigured === true ||
          currentHost?.privateKeyConfigured === true,
        privateKeyPassphrase,
        privateKeyPassphraseConfigured:
          privateKeyPassphrase.length > 0 ||
          host.privateKeyPassphraseConfigured === true ||
          currentHost?.privateKeyPassphraseConfigured === true,
        proxy: {
          ...host.proxy,
          password: proxyPassword,
          passwordConfigured:
            proxyPassword.length > 0 ||
            host.proxy.passwordConfigured === true ||
            currentHost?.proxy.passwordConfigured === true,
        },
      };
    }),
  };
}

function mergeSyncedProjectToolsFileTreeSettings(
  current: AppSettings["customSettings"]["projectToolsFileTree"],
  incoming: unknown,
): AppSettings["customSettings"]["projectToolsFileTree"] {
  const currentState = normalizeProjectToolsFileTreeSettings(current);
  const incomingState = normalizeProjectToolsFileTreeSettings(incoming);
  const openFromIncoming = incomingState.openVersion >= currentState.openVersion;
  const incomingOpenProjectPathKeys = new Set(incomingState.openProjectPathKeys);
  const projects: AppSettings["customSettings"]["projectToolsFileTree"]["projects"] = {
    ...currentState.projects,
  };

  for (const [pathKey, incomingProject] of Object.entries(incomingState.projects)) {
    const currentProject = projects[pathKey];
    if (!currentProject) {
      if (openFromIncoming && incomingOpenProjectPathKeys.has(pathKey)) {
        projects[pathKey] = incomingProject;
      }
      continue;
    }
    const uiSource =
      incomingProject.stateVersion >= currentProject.stateVersion
        ? incomingProject
        : currentProject;
    projects[pathKey] = {
      query: uiSource.query,
      selectedPath: uiSource.selectedPath,
      expandedPaths: uiSource.expandedPaths,
      stateVersion: Math.max(currentProject.stateVersion, incomingProject.stateVersion),
      revision: Math.max(currentProject.revision, incomingProject.revision),
    };
  }

  return {
    openProjectPathKeys: openFromIncoming
      ? incomingState.openProjectPathKeys
      : currentState.openProjectPathKeys,
    openVersion: Math.max(currentState.openVersion, incomingState.openVersion),
    projects,
  };
}

function mergeSyncedProjectToolsGitReviewSettings(
  current: AppSettings["customSettings"]["projectToolsGitReview"],
  incoming: unknown,
): AppSettings["customSettings"]["projectToolsGitReview"] {
  const currentState = normalizeProjectToolsGitReviewSettings(current);
  const incomingState = normalizeProjectToolsGitReviewSettings(incoming);
  const openFromIncoming = incomingState.openVersion >= currentState.openVersion;
  return {
    openProjectPathKeys: openFromIncoming
      ? incomingState.openProjectPathKeys
      : currentState.openProjectPathKeys,
    openVersion: Math.max(currentState.openVersion, incomingState.openVersion),
  };
}

function mergeSyncedProjectToolsTunnelSettings(
  current: AppSettings["customSettings"]["projectToolsTunnel"],
  incoming: unknown,
): AppSettings["customSettings"]["projectToolsTunnel"] {
  const currentState = normalizeProjectToolsTunnelSettings(current);
  const incomingState = normalizeProjectToolsTunnelSettings(incoming);
  const openFromIncoming = incomingState.openVersion >= currentState.openVersion;
  return {
    openProjectPathKeys: openFromIncoming
      ? incomingState.openProjectPathKeys
      : currentState.openProjectPathKeys,
    openVersion: Math.max(currentState.openVersion, incomingState.openVersion),
  };
}

function mergeSyncedProjectToolsSshTunnelSettings(
  current: AppSettings["customSettings"]["projectToolsSshTunnel"],
  incoming: unknown,
): AppSettings["customSettings"]["projectToolsSshTunnel"] {
  const currentState = normalizeProjectToolsSshTunnelSettings(current);
  const incomingState = normalizeProjectToolsSshTunnelSettings(incoming);
  const openFromIncoming = incomingState.openVersion >= currentState.openVersion;
  return {
    openProjectPathKeys: openFromIncoming
      ? incomingState.openProjectPathKeys
      : currentState.openProjectPathKeys,
    openVersion: Math.max(currentState.openVersion, incomingState.openVersion),
  };
}

export function buildGatewaySettingsSyncPayload(
  settings: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncPayload {
  const payload: GatewaySettingsSyncPayload = {
    system: syncableSystemSettings(settings.system),
    customProviders: redactCustomProvidersForGateway(settings.customProviders),
    mcp: settings.mcp,
    agents: settings.agents,
    ssh: redactSshSettingsForGateway(settings.ssh),
    hooks: settings.hooks,
    cron: settings.cron,
    remote: {
      enableWebTerminal: settings.remote.enableWebTerminal,
      enableWebSshTerminal: settings.remote.enableWebSshTerminal,
      enableWebGit: settings.remote.enableWebGit,
      enableWebTunnels: settings.remote.enableWebTunnels,
    },
    memory: settings.memory,
    customSettings: syncableCustomSettings(settings.customSettings),
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    selectedModel: settings.selectedModel ?? null,
    theme: settings.theme,
    locale: settings.locale,
  };
  const providerApiKeyUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderApiKeyUpdates(settings.customProviders)
    : undefined;
  if (providerApiKeyUpdates) {
    payload.providerApiKeyUpdates = providerApiKeyUpdates;
  }
  const sshSecretUpdates = options.includeProviderApiKeyUpdates
    ? collectSshSecretUpdates(settings.ssh)
    : undefined;
  if (sshSecretUpdates) {
    payload.sshSecretUpdates = sshSecretUpdates;
  }
  return payload;
}

export function buildGatewaySettingsSyncUpdatePayload(
  prev: AppSettings,
  next: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncUpdatePayload {
  const previousPayload = buildGatewaySettingsSyncPayload(prev);
  const nextPayload = buildGatewaySettingsSyncPayload(next, options);
  const update: GatewaySettingsSyncUpdatePayload = {};

  for (const field of GATEWAY_SETTINGS_SYNC_FIELDS) {
    if (JSON.stringify(previousPayload[field]) !== JSON.stringify(nextPayload[field])) {
      (update as Record<string, unknown>)[field] = nextPayload[field];
    }
  }

  if (nextPayload.providerApiKeyUpdates) {
    update.customProviders ??= nextPayload.customProviders;
    update.providerApiKeyUpdates = nextPayload.providerApiKeyUpdates;
  }
  if (nextPayload.sshSecretUpdates) {
    update.ssh ??= nextPayload.ssh;
    update.sshSecretUpdates = nextPayload.sshSecretUpdates;
  }

  return update;
}

export function applyGatewaySettingsSyncPayload(
  current: AppSettings,
  payload: unknown,
): AppSettings {
  const source = asObject(payload);
  const providerApiKeyUpdates = normalizeProviderApiKeyUpdates(source.providerApiKeyUpdates);
  const sshSecretUpdates = normalizeSshSecretUpdates(source.sshSecretUpdates);
  const selectedModel =
    source.selectedModel === null
      ? undefined
      : ((source.selectedModel as AppSettings["selectedModel"] | undefined) ??
        current.selectedModel);
  const memory = Object.prototype.hasOwnProperty.call(source, "memory")
    ? ((source.memory as AppSettings["memory"] | null | undefined) ?? {})
    : current.memory;
  const customSettings = Object.prototype.hasOwnProperty.call(source, "customSettings")
    ? ((source.customSettings as GatewaySettingsSyncCustomSettings | null | undefined) ?? {})
    : current.customSettings;
  const incomingCustomSettings = customSettings as GatewaySettingsSyncCustomSettings;

  return normalizeSettings({
    ...current,
    system: Object.prototype.hasOwnProperty.call(source, "system")
      ? mergeSyncedSystemSettings(current.system, source.system)
      : current.system,
    customProviders: mergeSyncedCustomProviders(
      current.customProviders,
      source.customProviders,
      providerApiKeyUpdates,
    ),
    mcp: (source.mcp as AppSettings["mcp"] | undefined) ?? current.mcp,
    agents: (source.agents as AppSettings["agents"] | undefined) ?? current.agents,
    ssh: Object.prototype.hasOwnProperty.call(source, "ssh")
      ? mergeSyncedSshSettings(current.ssh, source.ssh, sshSecretUpdates)
      : current.ssh,
    hooks: (source.hooks as AppSettings["hooks"] | undefined) ?? current.hooks,
    cron: (source.cron as AppSettings["cron"] | undefined) ?? current.cron,
    memory: memory as AppSettings["memory"],
    customSettings: {
      ...incomingCustomSettings,
      projectToolsFileTree: Object.prototype.hasOwnProperty.call(
        incomingCustomSettings,
        "projectToolsFileTree",
      )
        ? mergeSyncedProjectToolsFileTreeSettings(
            current.customSettings.projectToolsFileTree,
            incomingCustomSettings.projectToolsFileTree,
          )
        : current.customSettings.projectToolsFileTree,
      projectToolsGitReview: Object.prototype.hasOwnProperty.call(
        incomingCustomSettings,
        "projectToolsGitReview",
      )
        ? mergeSyncedProjectToolsGitReviewSettings(
            current.customSettings.projectToolsGitReview,
            incomingCustomSettings.projectToolsGitReview,
          )
        : current.customSettings.projectToolsGitReview,
      projectToolsTunnel: Object.prototype.hasOwnProperty.call(
        incomingCustomSettings,
        "projectToolsTunnel",
      )
        ? mergeSyncedProjectToolsTunnelSettings(
            current.customSettings.projectToolsTunnel,
            incomingCustomSettings.projectToolsTunnel,
          )
        : current.customSettings.projectToolsTunnel,
      projectToolsSshTunnel: Object.prototype.hasOwnProperty.call(
        incomingCustomSettings,
        "projectToolsSshTunnel",
      )
        ? mergeSyncedProjectToolsSshTunnelSettings(
            current.customSettings.projectToolsSshTunnel,
            incomingCustomSettings.projectToolsSshTunnel,
          )
        : current.customSettings.projectToolsSshTunnel,
      chatSidebar: current.customSettings.chatSidebar,
      projectToolsPanel: current.customSettings.projectToolsPanel,
    },
    skills: (source.skills as AppSettings["skills"] | undefined) ?? current.skills,
    chatRuntimeControls: Object.prototype.hasOwnProperty.call(source, "chatRuntimeControls")
      ? normalizeChatRuntimeControls(source.chatRuntimeControls)
      : current.chatRuntimeControls,
    selectedModel,
    theme: (source.theme as AppSettings["theme"] | undefined) ?? current.theme,
    locale: (source.locale as AppSettings["locale"] | undefined) ?? current.locale,
    remote: Object.prototype.hasOwnProperty.call(source, "remote")
      ? mergeSyncedRemoteSettings(current.remote, source.remote)
      : current.remote,
  });
}
