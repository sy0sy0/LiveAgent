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

test("loadWebSettings forces current gateway URL/token over stale persisted remote settings", () => {
  const store = installWindow("https://new.example");
  const stale = webSettings.getWebDefaultSettings("old-token");
  stale.remote.gatewayUrl = "https://old.example";
  stale.remote.token = "old-token";
  stale.system.workdir = "/workspace";
  store.set("liveagent.gateway.webui.settings.v1", JSON.stringify(stale));

  const loaded = webSettings.loadWebSettings(" new-token ");
  assert.equal(loaded.system.workdir, "/workspace");
  assert.equal(loaded.remote.gatewayUrl, "https://new.example");
  assert.equal(loaded.remote.token, "new-token");
  assert.equal(loaded.remote.enabled, true);
});

test("gateway settings sync payload excludes remote settings and applies selectedModel null", () => {
  installWindow();
  const current = webSettings.getWebDefaultSettings("token");
  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    system: {
      executionMode: "tools",
      workdir: "/remote-workdir",
      selectedSystemTools: ["http_get_test"],
    },
    selectedModel: null,
  });

  assert.equal(synced.system.executionMode, "tools");
  assert.equal(synced.system.workdir, "/remote-workdir");
  assert.deepEqual(synced.system.selectedSystemTools, ["http_get_test"]);
  assert.equal(synced.selectedModel, undefined);
  assert.equal(synced.remote.gatewayUrl, "https://gateway.example");
  assert.equal(synced.remote.token, "token");

  const payload = settingsSync.buildGatewaySettingsSyncPayload(synced);
  assert.equal(Object.hasOwn(payload, "remote"), false);
});

test("web remote settings normalize single-slash http gateway URLs", () => {
  const remote = settings.normalizeRemoteSettings({
    enabled: true,
    gatewayUrl: " https:/gateway.example/ ",
    token: " token ",
  });

  assert.equal(remote.gatewayUrl, "https://gateway.example");
  assert.equal(remote.token, "token");
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
