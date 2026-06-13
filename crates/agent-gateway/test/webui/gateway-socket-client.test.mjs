import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

class FakeMessagePort {
  messages = [];
  closed = false;
  onmessage = null;
  onmessageerror = null;

  postMessage(message) {
    this.messages.push(message);
  }

  start() {}

  close() {
    this.closed = true;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  readyState = FakeWebSocket.CONNECTING;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(envelope) {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  close(event = {}) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({
      code: event.code ?? 1006,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? false,
    });
  }
}

function installBrowser(options = {}) {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  delete globalThis.SharedWorker;
  const windowListeners = new Map();
  const documentListeners = new Map();
  const addListener = (listeners, type, listener) => {
    const items = listeners.get(type) ?? new Set();
    items.add(listener);
    listeners.set(type, items);
  };
  const removeListener = (listeners, type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  const dispatch = (listeners, event) => {
    const type = event?.type;
    if (typeof type !== "string") return;
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  globalThis.window = {
    location: { origin: "https://gateway.example" },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    setInterval: options.setInterval ?? setInterval,
    clearInterval: options.clearInterval ?? clearInterval,
    addEventListener: (type, listener) => addListener(windowListeners, type, listener),
    removeEventListener: (type, listener) => removeListener(windowListeners, type, listener),
    dispatchEvent: (event) => {
      dispatch(windowListeners, event);
      return true;
    },
  };
  globalThis.document = {
    visibilityState: options.visibilityState ?? "visible",
    addEventListener: (type, listener) => addListener(documentListeners, type, listener),
    removeEventListener: (type, listener) => removeListener(documentListeners, type, listener),
    dispatchEvent: (event) => {
      dispatch(documentListeners, event);
      return true;
    },
  };
}

class FakeSharedWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.port = new FakeMessagePort();
    FakeSharedWorker.instances.push(this);
  }
}

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 500) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

async function connectAndAuth(index = 0) {
  await waitFor(() => FakeWebSocket.instances.length > index, "websocket construction");
  const socket = FakeWebSocket.instances[index];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "auth envelope");
  assert.equal(socket.url, "wss://gateway.example/ws");
  assert.equal(socket.sent[0].type, "auth");
  assert.deepEqual(socket.sent[0].payload, { token: "token" });
  socket.receive({ id: socket.sent[0].id, type: "response", payload: { ok: true } });
  return socket;
}

test("GatewayWebSocketClient authenticates once and sends status requests over /ws", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "status envelope");
  assert.equal(socket.sent[1].type, "status.get");
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });

  const status = await statusPromise;
  assert.deepEqual(status, { online: true, agent_id: "desktop-agent" });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends git requests with workdir and args", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const gitPromise = client.gitRequest("diff", "/workspace/project", { mode: "branch" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((message) => message.type === "git.diff"), "git.diff envelope");
  const request = socket.sent.find((message) => message.type === "git.diff");
  assert.deepEqual(request.payload, {
    workdir: "/workspace/project",
    args: { mode: "branch" },
  });
  socket.receive({
    id: request.id,
    type: "response",
    payload: { patch: "diff --git a/file b/file" },
  });

  assert.deepEqual(await gitPromise, { patch: "diff --git a/file b/file" });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not recover mutating git requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const stagePromise = client.gitRequest("stage", "/workspace/project", { path: "src/main.rs" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((message) => message.type === "git.stage"), "git.stage envelope");
  socket.close({ code: 1006, wasClean: false });

  await assert.rejects(stagePromise, /Gateway WebSocket disconnected/);
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client sends conversation cancel even without a local stream", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  assert.equal(FakeSharedWorker.instances.length, 1);
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  await client.cancelChat(" conversation-1 ");

  const cancel = port.messages.find((message) => message.type === "chat.cancel");
  assert.deepEqual(cancel, {
    type: "chat.cancel",
    connection_id: connect.connection_id,
    stream_id: "",
    conversation_id: "conversation-1",
  });

  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client forwards foreground wakeups to the worker", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  getGatewayWebSocketClient(" token ");
  assert.equal(FakeSharedWorker.instances.length, 1);
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  window.dispatchEvent({ type: "pageshow" });

  assert.deepEqual(port.messages.at(-1), {
    type: "wakeup",
    connection_id: connect.connection_id,
  });

  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client accepts terminal list sessions from worker payload", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  const sessionsPromise = client.listTerminals("/workspace/project");
  await waitFor(
    () => port.messages.some((message) => message.method === "terminal.list"),
    "shared worker terminal.list request",
  );
  const request = port.messages.find((message) => message.method === "terminal.list");
  assert.deepEqual(request.payload, { project_path_key: "/workspace/project" });

  port.emit({
    type: "response",
    connection_id: connect.connection_id,
    request_id: request.request_id,
    payload: {
      sessions: [
        {
          id: "terminal-1",
          project_path_key: "/workspace/project",
          cwd: "/workspace/project",
          title: "Terminal 1",
          created_at: 1,
          updated_at: 2,
          running: true,
        },
      ],
    },
  });

  const sessions = await sessionsPromise;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "terminal-1");
  assert.equal(sessions[0].projectPathKey, "/workspace/project");
  assert.equal(sessions[0].title, "Terminal 1");

  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client keeps SSH create snapshots from worker payload", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  const createPromise = client.createSshTerminal({
    cwd: "/workspace/project",
    projectPathKey: "project-key",
    hostId: "host-1",
  });
  await waitFor(
    () => port.messages.some((message) => message.type === "request" && message.method === "terminal.create_ssh"),
    "terminal.create_ssh worker request",
  );
  const request = port.messages.find((message) => message.type === "request" && message.method === "terminal.create_ssh");
  assert.ok(request);
  assert.deepEqual(request.payload, {
    cwd: "/workspace/project",
    project_path_key: "project-key",
    ssh_host_id: "host-1",
    title: undefined,
    cols: undefined,
    rows: undefined,
  });
  port.emit({
    type: "response",
    connection_id: connect.connection_id,
    request_id: request.request_id,
    payload: {
      snapshot: {
        session: {
          id: "ssh-1",
          projectPathKey: "project-key",
          cwd: "/workspace/project",
          shell: "ssh",
          title: "Claw-SG",
          kind: "ssh",
          ssh: {
            hostId: "host-1",
            hostName: "Claw-SG",
            username: "root",
            host: "8.219.204.112",
            port: 22,
            authType: "privateKey",
            status: "connected",
            reconnectAttempt: 0,
            reconnectMaxAttempts: 3,
          },
          pid: null,
          cols: 80,
          rows: 24,
          createdAt: 10,
          updatedAt: 10,
          running: true,
        },
        output: "root@s878169:~# ",
        truncated: false,
        outputStartOffset: 0,
        outputEndOffset: 18,
      },
    },
  });

  const result = await createPromise;
  assert.equal(result.snapshot?.session.id, "ssh-1");
  assert.equal(result.snapshot?.session.ssh?.hostId, "host-1");
  assert.equal(result.snapshot?.output, "root@s878169:~# ");
  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client forwards chat runtime controls to the worker", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  assert.equal(FakeSharedWorker.instances.length, 1);
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  const stream = client.chat(
    "hello",
    "conversation-1",
    { customProviderId: "claude-provider", model: "claude-test", providerType: "claude_code" },
    { executionMode: "agent-dev", workdir: "/workspace", selectedSystemTools: ["http_get_test"] },
    undefined,
    [
      {
        relativePath: "uploads/notes.txt",
        absolutePath: "/workspace/uploads/notes.txt",
        fileName: "notes.txt",
        kind: "text",
        sizeBytes: 12,
      },
    ],
    "client-submit-1",
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
    },
  );
  const firstEventPromise = stream.next();

  await waitFor(
    () => port.messages.some((message) => message.type === "chat.start"),
    "shared worker client chat.start message",
  );
  const chatStart = port.messages.find((message) => message.type === "chat.start");
  assert.equal(chatStart.connection_id, connect.connection_id);
  assert.equal(typeof chatStart.request_id, "string");
  assert.equal(typeof chatStart.stream_id, "string");
  assert.deepEqual(chatStart.payload, {
    message: "hello",
    conversation_id: "conversation-1",
    client_request_id: "client-submit-1",
    selected_model: {
      customProviderId: "claude-provider",
      model: "claude-test",
      providerType: "claude_code",
    },
    runtime_controls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
    },
    system_settings: {
      executionMode: "agent-dev",
      workdir: "/workspace",
      selectedSystemTools: ["http_get_test"],
    },
    uploaded_files: [
      {
        relativePath: "uploads/notes.txt",
        absolutePath: "/workspace/uploads/notes.txt",
        fileName: "notes.txt",
        kind: "text",
        sizeBytes: 12,
      },
    ],
  });

  port.emit({
    type: "response",
    connection_id: connect.connection_id,
    request_id: chatStart.request_id,
    payload: { ok: true },
  });
  port.emit({
    type: "chat-event",
    connection_id: connect.connection_id,
    stream_id: chatStart.stream_id,
    payload: { type: "done", conversation_id: "conversation-1" },
  });
  assert.deepEqual(await firstEventPromise, {
    value: { type: "done", conversation_id: "conversation-1" },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });

  resetGatewayWebSocketClient();
});

test("Gateway SharedWorker broadcasts events with each port connection id", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");
  assert.equal(typeof globalThis.onconnect, "function");

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });

  firstPort.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  assert.equal(clientInstances.length, 1);
  assert.equal(clientInstances[0].token, "token");
  assert.deepEqual(firstPort.messages.at(-1), {
    type: "ready",
    connection_id: "connection-1",
    payload: { status: null, error: null },
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "ready",
    connection_id: "connection-2",
    payload: { status: null, error: null },
  });

  const historyEvent = { kind: "idle", conversation_id: "conversation-1" };
  clientInstances[0].historyListeners[0](historyEvent);

  assert.deepEqual(firstPort.messages.at(-1), {
    type: "event",
    event_type: "history",
    connection_id: "connection-1",
    payload: historyEvent,
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "history",
    connection_id: "connection-2",
    payload: historyEvent,
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker applies foreground wakeups to the managed socket client", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    wakeups = 0;

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    noteForegroundWakeup() {
      this.wakeups += 1;
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({ type: "wakeup", connection_id: "connection-1" });

  assert.equal(clientInstances.length, 1);
  assert.equal(clientInstances[0].wakeups, 1);

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker terminal metadata reaches every page while output stays scoped", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    async listTerminals(projectPathKey) {
      this.calls.push(["listTerminals", projectPathKey ?? ""]);
      return [
        {
          id: "terminal-1",
          projectPathKey: "/workspace/project-a",
          cwd: "/workspace/project-a",
          shell: "zsh",
          title: "Terminal 1",
          cols: 80,
          rows: 24,
          createdAt: 1,
          updatedAt: 1,
          running: true,
        },
      ];
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });
  firstPort.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "terminal-list-all",
    method: "terminal.list",
    payload: {},
  });
  await waitFor(
    () => firstPort.messages.some((message) => message.request_id === "terminal-list-all"),
    "terminal list all response",
  );
  assert.deepEqual(clientInstances[0].calls, [["listTerminals", ""]]);
  const listResponse = firstPort.messages.find(
    (message) => message.request_id === "terminal-list-all",
  );
  assert.equal(listResponse.payload.sessions[0].id, "terminal-1");

  const event = {
    kind: "created",
    sessionId: "terminal-2",
    projectPathKey: "/workspace/project-b",
    session: {
      id: "terminal-2",
      projectPathKey: "/workspace/project-b",
      cwd: "/workspace/project-b",
      shell: "zsh",
      title: "Terminal 2",
      cols: 80,
      rows: 24,
      createdAt: 2,
      updatedAt: 2,
      running: true,
    },
  };
  clientInstances[0].terminalListeners[0](event);

  assert.deepEqual(firstPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-1",
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-2",
  });

  const outputEvent = {
    ...event,
    kind: "output",
    data: "secret\n",
  };
  clientInstances[0].terminalListeners[0](outputEvent);

  assert.equal(
    firstPort.messages.some((message) => message.payload === outputEvent),
    false,
  );
  assert.equal(
    secondPort.messages.some((message) => message.payload === outputEvent),
    false,
  );

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards terminal output while attach request is pending", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];
  let resolveSnapshot = null;

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    snapshotTerminal(sessionId, maxBytes, projectPathKey) {
      this.calls.push(["snapshotTerminal", sessionId, maxBytes, projectPathKey]);
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "terminal-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => clientInstances[0]?.calls.some((call) => call[0] === "snapshotTerminal"),
    "terminal attach request",
  );

  const event = {
    kind: "output",
    sessionId: "terminal-1",
    projectPathKey: "/workspace/project",
    session: {
      id: "terminal-1",
      projectPathKey: "/workspace/project",
      cwd: "/workspace/project",
      shell: "zsh",
      title: "Terminal 1",
      cols: 80,
      rows: 24,
      createdAt: 1,
      updatedAt: 2,
      running: true,
    },
    data: "pwd\r\n",
    outputStartOffset: 10,
    outputEndOffset: 15,
  };
  clientInstances[0].terminalListeners[0](event);
  await waitFor(
    () =>
      port.messages.some(
        (message) => message.event_type === "terminal" && message.payload === event,
      ),
    "attach-pending terminal output",
  );

  resolveSnapshot({
    session: event.session,
    output: "",
    truncated: false,
    outputStartOffset: 15,
    outputEndOffset: 15,
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "terminal-attach"),
    "terminal attach response",
  );

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker keeps upstream terminal attached until every port detaches", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    async snapshotTerminal(sessionId, maxBytes, projectPathKey) {
      this.calls.push(["snapshotTerminal", sessionId, maxBytes, projectPathKey]);
      return {
        session: {
          id: sessionId,
          projectPathKey,
          cwd: projectPathKey,
          shell: "zsh",
          title: "Terminal 1",
          cols: 80,
          rows: 24,
          createdAt: 1,
          updatedAt: 1,
          running: true,
        },
        output: "",
        truncated: false,
        outputStartOffset: 0,
        outputEndOffset: 0,
      };
    }

    async detachTerminal(sessionId, projectPathKey) {
      this.calls.push(["detachTerminal", sessionId, projectPathKey]);
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });
  firstPort.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "first-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  secondPort.emit({
    type: "request",
    connection_id: "connection-2",
    request_id: "second-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () =>
      firstPort.messages.some((message) => message.request_id === "first-attach") &&
      secondPort.messages.some((message) => message.request_id === "second-attach"),
    "terminal attach responses",
  );

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "first-detach",
    method: "terminal.detach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => firstPort.messages.some((message) => message.request_id === "first-detach"),
    "first terminal detach response",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    clientInstances[0].calls.some((call) => call[0] === "detachTerminal"),
    false,
  );

  const firstPortMessageCount = firstPort.messages.length;
  const event = {
    kind: "output",
    sessionId: "terminal-1",
    projectPathKey: "/workspace/project",
    session: {
      id: "terminal-1",
      projectPathKey: "/workspace/project",
      cwd: "/workspace/project",
      shell: "zsh",
      title: "Terminal 1",
      cols: 80,
      rows: 24,
      createdAt: 1,
      updatedAt: 2,
      running: true,
    },
    data: "pwd\r\n",
  };
  clientInstances[0].terminalListeners[0](event);
  assert.equal(firstPort.messages.length, firstPortMessageCount);
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-2",
  });

  secondPort.emit({
    type: "request",
    connection_id: "connection-2",
    request_id: "second-detach",
    method: "terminal.detach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => clientInstances[0].calls.some((call) => call[0] === "detachTerminal"),
    "upstream terminal detach",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "detachTerminal",
    "terminal-1",
    "/workspace/project",
  ]);

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards chat metadata and uploaded files", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const chatCalls = [];

  class MockGatewayWebSocketClient {
    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    async *chat(...args) {
      chatCalls.push(args);
      yield { type: "done", conversation_id: "conversation-1" };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({
    type: "chat.start",
    connection_id: "connection-1",
    request_id: "request-1",
    stream_id: "stream-1",
    payload: {
      message: "inspect",
      conversation_id: "conversation-1",
      client_request_id: "client-submit-1",
      selected_model: {
        customProviderId: "gemini-provider",
        model: "gemini-test",
        providerType: "gemini",
      },
      system_settings: {
        executionMode: "text",
        workdir: "/workspace",
        selectedSystemTools: [],
      },
      uploaded_files: [
        {
          relativePath: "uploads/screenshot.png",
          absolutePath: "/workspace/uploads/screenshot.png",
          fileName: "screenshot.png",
          kind: "image",
          sizeBytes: 12,
        },
      ],
      runtime_controls: {
        thinkingEnabled: false,
        nativeWebSearchEnabled: true,
        reasoning: "medium",
      },
    },
  });

  const response = port.messages.at(-1);
  assert.equal(response.type, "response");
  assert.equal(response.connection_id, "connection-1");
  assert.equal(response.request_id, "request-1");
  assert.deepEqual(response.payload, { ok: true });
  await waitFor(() => chatCalls.length === 1, "shared worker chat call");

  assert.deepEqual(chatCalls[0], [
    "inspect",
    "conversation-1",
    {
      customProviderId: "gemini-provider",
      model: "gemini-test",
      providerType: "gemini",
    },
    {
      executionMode: "text",
      workdir: "/workspace",
      selectedSystemTools: [],
    },
    chatCalls[0][4],
    [
      {
        relativePath: "uploads/screenshot.png",
        absolutePath: "/workspace/uploads/screenshot.png",
        fileName: "screenshot.png",
        kind: "image",
        sizeBytes: 12,
      },
    ],
    "client-submit-1",
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "medium",
    },
  ]);
  assert.ok(chatCalls[0][4] instanceof AbortSignal);

  globalThis.onconnect = previousOnConnect;
});

test("GatewayWebSocketClient sends mention query payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const mentionPromise = client.listMentionFiles("/workspace", 200, "src");
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "mentions envelope");
  assert.equal(socket.sent[1].type, "mentions.list");
  assert.deepEqual(socket.sent[1].payload, {
    workdir: "/workspace",
    max_results: 200,
    query: "src",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { entries: [{ path: "src/main.ts", kind: "file" }], truncated: false },
  });

  assert.deepEqual(await mentionPromise, {
    entries: [{ path: "src/main.ts", kind: "file" }],
    truncated: false,
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends memory manage payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const memoryPromise = client.memoryManage({
    command: "memory_search",
    args: { query: "Kevin", limit: 3 },
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "memory envelope");
  assert.equal(socket.sent[1].type, "memory.manage");
  assert.deepEqual(socket.sent[1].payload, {
    command: "memory_search",
    args: { query: "Kevin", limit: 3 },
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { matches: [], usedFallback: false },
  });

  assert.deepEqual(await memoryPromise, { matches: [], usedFallback: false });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient retries recoverable memory manage commands after a clean disconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const updatePromise = client.memoryManage({
    command: "memory_organize_run_update",
    args: {
      runId: "run-1",
      safeApplied: 2,
      trimmedProtocol: {
        manualApplyState: { status: "applied" },
      },
    },
  });

  const firstSocket = await connectAndAuth(0);
  await waitFor(
    () => firstSocket.sent.some((item) => item.type === "memory.manage"),
    "initial memory update envelope",
  );
  const firstRequest = firstSocket.sent.find((item) => item.type === "memory.manage");
  assert.deepEqual(firstRequest.payload, {
    command: "memory_organize_run_update",
    args: {
      runId: "run-1",
      safeApplied: 2,
      trimmedProtocol: {
        manualApplyState: { status: "applied" },
      },
    },
  });

  firstSocket.close({ code: 1000, wasClean: true });
  await waitFor(() => FakeWebSocket.instances.length === 2, "memory update recovery websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "memory update recovery auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "memory.manage"),
    "retried memory update envelope",
  );

  const retriedRequest = reconnectSocket.sent.find((item) => item.type === "memory.manage");
  assert.deepEqual(retriedRequest.payload, firstRequest.payload);
  const payload = {
    runId: "run-1",
    status: "succeeded",
    trimmedProtocol: {
      manualApplyState: { status: "applied" },
    },
  };
  reconnectSocket.receive({
    id: retriedRequest.id,
    type: "response",
    payload,
  });

  assert.deepEqual(await updatePromise, payload);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not replay memory apply batch after a disconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const applyPromise = client.memoryManage({
    command: "memory_apply_batch",
    args: {
      trigger: "memory-organize",
      decisions: [
        {
          op: "delete",
          slug: "stale-memory",
          scope: "project",
        },
      ],
    },
  });

  const socket = await connectAndAuth(0);
  await waitFor(
    () => socket.sent.some((item) => item.type === "memory.manage"),
    "memory apply envelope",
  );
  socket.close({ code: 1000, wasClean: true });

  await assert.rejects(
    applyPromise,
    /Gateway WebSocket disconnected \(code=1000 clean=true\)/,
  );
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends skill manage payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const skillPromise = client.manageSkill({
    action: "list",
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "skill manage envelope");
  assert.equal(socket.sent[1].type, "skills.manage");
  assert.deepEqual(socket.sent[1].payload, {
    action: "list",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { action: "list", rootDir: "/Users/me/.liveagent/skills", skills: [] },
  });

  assert.deepEqual(await skillPromise, {
    action: "list",
    rootDir: "/Users/me/.liveagent/skills",
    skills: [],
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends history list requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(2, 50);
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, { page: 2, page_size: 50 });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: {
      conversations: [],
      total_count: 0,
      running_conversation_ids: ["conversation-running"],
      running_conversations: [
        {
          conversation_id: "conversation-running",
          cwd: "/tmp/project-a",
          updated_at: 123,
        },
      ],
    },
  });
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: ["conversation-running"],
    running_conversations: [
      {
        conversation_id: "conversation-running",
        cwd: "/tmp/project-a",
        updated_at: 123,
      },
    ],
  });

  const sharedListPromise = client.listSharedHistory(1, 25);
  await waitFor(() => socket.sent.length >= 3, "shared history list envelope");
  assert.equal(socket.sent[2].type, "history.shared_list");
  assert.deepEqual(socket.sent[2].payload, { page: 1, page_size: 25 });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0 },
  });
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends project-aware history and fs requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const filteredListPromise = client.listHistory(3, 25, { cwd: "/tmp/project-a" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "filtered history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, {
    page: 3,
    page_size: 25,
    cwd: "/tmp/project-a",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await filteredListPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const chatModeListPromise = client.listHistory(1, 80, { cwdEmpty: true });
  await waitFor(() => socket.sent.length >= 3, "cwd empty history list envelope");
  assert.equal(socket.sent[2].type, "history.list");
  assert.deepEqual(socket.sent[2].payload, {
    page: 1,
    page_size: 80,
    cwd_empty: true,
  });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await chatModeListPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const workdirsPromise = client.listHistoryWorkdirs();
  await waitFor(() => socket.sent.length >= 4, "history workdirs envelope");
  assert.equal(socket.sent[3].type, "history.workdirs");
  assert.deepEqual(socket.sent[3].payload, {});
  socket.receive({
    id: socket.sent[3].id,
    type: "response",
    payload: {
      workdirs: [
        { path: "/tmp/project-a", conversation_count: 2, updated_at: 1700000000300 },
      ],
    },
  });
  assert.deepEqual(await workdirsPromise, {
    workdirs: [
      { path: "/tmp/project-a", conversationCount: 2, updatedAt: 1700000000300 },
    ],
  });

  const createPromise = client.createProjectFolder("/tmp", "Project A");
  await waitFor(() => socket.sent.length >= 5, "create project folder envelope");
  assert.equal(socket.sent[4].type, "fs.create_project_folder");
  assert.deepEqual(socket.sent[4].payload, { parent: "/tmp", name: "Project A" });
  socket.receive({
    id: socket.sent[4].id,
    type: "response",
    payload: { path: "/tmp/Project A" },
  });
  assert.deepEqual(await createPromise, { path: "/tmp/Project A" });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient defaults invalid history pagination", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(0, 0);
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, { page: 1, page_size: 80 });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const sharedListPromise = client.listSharedHistory(Number.NaN, 500);
  await waitFor(() => socket.sent.length >= 3, "shared history list envelope");
  assert.equal(socket.sent[2].type, "history.shared_list");
  assert.deepEqual(socket.sent[2].payload, { page: 1, page_size: 200 });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0 },
  });
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends history share requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const getPromise = client.getHistoryShare("conversation-1");
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history share get envelope");
  assert.equal(socket.sent[1].type, "history.share.get");
  assert.deepEqual(socket.sent[1].payload, {
    conversation_id: "conversation-1",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: {
      conversation_id: "conversation-1",
      enabled: false,
      token: "",
      created_at: 0,
      updated_at: 0,
    },
  });
  assert.deepEqual(await getPromise, {
    conversation_id: "conversation-1",
    enabled: false,
    token: "",
    created_at: 0,
    updated_at: 0,
  });

  const setPromise = client.setHistoryShare("conversation-1", true, {
    redactToolContent: true,
  });
  await waitFor(() => socket.sent.length >= 3, "history share set envelope");
  assert.equal(socket.sent[2].type, "history.share.set");
  assert.deepEqual(socket.sent[2].payload, {
    conversation_id: "conversation-1",
    enabled: true,
    redact_tool_content: true,
  });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      token: "share-token",
      created_at: 10,
      updated_at: 20,
      redact_tool_content: true,
    },
  });
  assert.deepEqual(await setPromise, {
    conversation_id: "conversation-1",
    enabled: true,
    token: "share-token",
    created_at: 10,
    updated_at: 20,
    redact_tool_content: true,
  });

  resetGatewayWebSocketClient();
});

test("Gateway SharedWorker forwards history share requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    getHistoryShare(conversationID) {
      this.calls.push(["getHistoryShare", conversationID]);
      return {
        conversation_id: conversationID,
        enabled: false,
        token: "",
        created_at: 0,
        updated_at: 0,
      };
    }

    setHistoryShare(conversationID, enabled, options) {
      this.calls.push(["setHistoryShare", conversationID, enabled, options]);
      return {
        conversation_id: conversationID,
        enabled,
        token: enabled ? "share-token" : "",
        created_at: 10,
        updated_at: 20,
        redact_tool_content: options?.redactToolContent === true,
      };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  assert.equal(clientInstances.length, 1);

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "share-get",
    method: "history.share.get",
    payload: { conversation_id: "conversation-1" },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "share-get"),
    "shared worker history share get response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["getHistoryShare", "conversation-1"]);
  assert.deepEqual(port.messages.at(-1), {
    type: "response",
    connection_id: "connection-1",
    request_id: "share-get",
    payload: {
      conversation_id: "conversation-1",
      enabled: false,
      token: "",
      created_at: 0,
      updated_at: 0,
    },
    error: undefined,
  });

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "share-set",
    method: "history.share.set",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      redact_tool_content: true,
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "share-set"),
    "shared worker history share set response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "setHistoryShare",
    "conversation-1",
    true,
    { redactToolContent: true },
  ]);
  assert.deepEqual(port.messages.at(-1), {
    type: "response",
    connection_id: "connection-1",
    request_id: "share-set",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      token: "share-token",
      created_at: 10,
      updated_at: 20,
      redact_tool_content: true,
    },
    error: undefined,
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards tunnel requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    listTunnels() {
      this.calls.push(["listTunnels"]);
      return [
        {
          id: "tun-1",
          slug: "slug-1",
          name: "App",
          targetUrl: "http://localhost:3000",
          publicUrl: "https://gateway.example/t/slug-1/",
          createdAt: 10,
          expiresAt: 3700,
          activeConnections: 0,
          status: "active",
        },
      ];
    }

    createTunnel(input) {
      this.calls.push(["createTunnel", input]);
      return {
        id: "tun-2",
        slug: "slug-2",
        name: input.name ?? "",
        targetUrl: input.targetUrl,
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: 920,
        activeConnections: 0,
        status: "active",
      };
    }

    updateTunnel(input) {
      this.calls.push(["updateTunnel", input]);
      return {
        id: input.id,
        slug: "slug-2",
        name: input.name ?? "",
        targetUrl: input.targetUrl,
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: input.ttlSeconds === 0 ? 0 : 920,
        activeConnections: 0,
        status: "active",
        projectPathKey: input.projectPathKey ?? "",
      };
    }

    closeTunnel(id) {
      this.calls.push(["closeTunnel", id]);
      return {
        id,
        slug: "slug-2",
        name: "Closed",
        targetUrl: "http://localhost:3000",
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: 920,
        activeConnections: 0,
        status: "expired",
      };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  assert.equal(clientInstances.length, 1);

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-list",
    method: "tunnel.list",
    payload: {},
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-list"),
    "shared worker tunnel list response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["listTunnels"]);
  assert.equal(port.messages.at(-1).payload.tunnels[0].id, "tun-1");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-create",
    method: "tunnel.create",
    payload: {
      targetUrl: "http://localhost:3000/app",
      ttlSeconds: 900,
      name: "App",
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-create"),
    "shared worker tunnel create response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "createTunnel",
    {
      targetUrl: "http://localhost:3000/app",
      ttlSeconds: 900,
      name: "App",
    },
  ]);
  assert.equal(port.messages.at(-1).payload.tunnel.id, "tun-2");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-update-infinite",
    method: "tunnel.update",
    payload: {
      id: "tun-2",
      targetUrl: "http://localhost:4000/dashboard",
      ttlSeconds: 0,
      name: "Dashboard",
      projectPathKey: "project:/tmp/liveagent",
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-update-infinite"),
    "shared worker tunnel update response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "updateTunnel",
    {
      id: "tun-2",
      targetUrl: "http://localhost:4000/dashboard",
      ttlSeconds: 0,
      name: "Dashboard",
      projectPathKey: "project:/tmp/liveagent",
    },
  ]);
  assert.equal(port.messages.at(-1).payload.tunnel.expiresAt, 0);
  assert.equal(port.messages.at(-1).payload.tunnel.projectPathKey, "project:/tmp/liveagent");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-close",
    method: "tunnel.close",
    payload: { id: "tun-2" },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-close"),
    "shared worker tunnel close response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["closeTunnel", "tun-2"]);
  assert.equal(port.messages.at(-1).payload.tunnel.status, "expired");

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards chat.attach streams to the requesting port", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    async *attachChat(conversationID, options) {
      this.calls.push(["attachChat", conversationID, options.afterSeq]);
      yield {
        type: "token",
        text: "replayed",
        conversation_id: conversationID,
        seq: 8,
      };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  assert.equal(clientInstances.length, 1);

  port.emit({
    type: "chat.attach",
    connection_id: "connection-1",
    request_id: "attach-req",
    stream_id: "attach-stream",
    conversation_id: "conversation-1",
    after_seq: 7,
  });

  await waitFor(
    () => port.messages.some((message) => message.request_id === "attach-req"),
    "shared worker chat attach response",
  );
  assert.deepEqual(port.messages.find((message) => message.request_id === "attach-req"), {
    type: "response",
    connection_id: "connection-1",
    request_id: "attach-req",
    payload: { ok: true },
    error: undefined,
  });
  await waitFor(
    () => port.messages.some((message) => message.type === "chat-event"),
    "shared worker chat attach event",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["attachChat", "conversation-1", 7]);
  assert.deepEqual(port.messages.find((message) => message.type === "chat-event"), {
    type: "chat-event",
    connection_id: "connection-1",
    stream_id: "attach-stream",
    payload: {
      type: "token",
      text: "replayed",
      conversation_id: "conversation-1",
      seq: 8,
    },
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards conversation cancel without a stream id", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const cancelCalls = [];

  class MockGatewayWebSocketClient {
    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    async cancelChat(conversationID) {
      cancelCalls.push(conversationID);
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({
    type: "chat.cancel",
    connection_id: "connection-1",
    stream_id: "",
    conversation_id: " conversation-1 ",
  });

  await waitFor(() => cancelCalls.length === 1, "shared worker cancel call");
  assert.deepEqual(cancelCalls, ["conversation-1"]);

  globalThis.onconnect = previousOnConnect;
});

test("GatewayWebSocketClient resumes an active chat stream after reconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.chat("hello", "conversation-1");
  const firstEventPromise = stream.next();
  const firstSocket = await connectAndAuth(0);
  await waitFor(() => firstSocket.sent.length >= 2, "chat.start envelope");
  const chatStart = firstSocket.sent[1];
  assert.equal(chatStart.type, "chat.start");

  firstSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 1,
    },
  });
  assert.deepEqual(await firstEventPromise, {
    value: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 1,
    },
    done: false,
  });

  const replayPromise = stream.next();
  firstSocket.close();
  await waitFor(() => FakeWebSocket.instances.length === 2, "reconnect websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "reconnect auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.resume"),
    "chat.resume envelope",
  );
  const resume = reconnectSocket.sent.find((item) => item.type === "chat.resume");
  assert.deepEqual(resume.payload, {
    request_id: chatStart.id,
    conversation_id: "conversation-1",
    after_seq: 1,
  });

  reconnectSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 2,
    },
  });
  assert.deepEqual(await replayPromise, {
    value: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 2,
    },
    done: false,
  });

  const donePromise = stream.next();
  reconnectSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "done", conversation_id: "conversation-1", seq: 3 },
  });
  assert.deepEqual(await donePromise, {
    value: { type: "done", conversation_id: "conversation-1", seq: 3 },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient attachChat replays by conversation id and reattaches after reconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.attachChat(" conversation-1 ", { afterSeq: 1 });
  const firstEventPromise = stream.next();
  const firstSocket = await connectAndAuth(0);
  await waitFor(() => firstSocket.sent.length >= 2, "chat.attach envelope");
  const firstAttach = firstSocket.sent[1];
  assert.equal(firstAttach.type, "chat.attach");
  assert.deepEqual(firstAttach.payload, {
    conversation_id: "conversation-1",
    after_seq: 1,
  });

  firstSocket.receive({
    id: firstAttach.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 2,
    },
  });
  assert.deepEqual(await firstEventPromise, {
    value: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 2,
    },
    done: false,
  });

  const replayPromise = stream.next();
  firstSocket.close();
  await waitFor(() => FakeWebSocket.instances.length === 2, "attach reconnect websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "attach reconnect auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.attach"),
    "reattach envelope",
  );
  const reattach = reconnectSocket.sent.find((item) => item.type === "chat.attach");
  assert.deepEqual(reattach.payload, {
    conversation_id: "conversation-1",
    after_seq: 2,
  });

  reconnectSocket.receive({
    id: firstAttach.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 3,
    },
  });
  assert.deepEqual(await replayPromise, {
    value: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 3,
    },
    done: false,
  });

  const closePromise = stream.return();
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.detach"),
    "chat.detach envelope",
  );
  const detach = reconnectSocket.sent.find((item) => item.type === "chat.detach");
  assert.deepEqual(detach.payload, { request_id: firstAttach.id });
  assert.deepEqual(await closePromise, { value: undefined, done: true });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient reconnects before read requests when an authenticated socket goes stale", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const realDateNow = Date.now;
  try {
    const client = getGatewayWebSocketClient("token");
    const statusPromise = client.getStatus();
    const firstSocket = await connectAndAuth();
    await waitFor(() => firstSocket.sent.some((item) => item.type === "status.get"), "initial status.get");
    const statusRequest = firstSocket.sent.find((item) => item.type === "status.get");
    firstSocket.receive({
      id: statusRequest.id,
      type: "response",
      payload: { online: true, agent_id: "desktop-agent" },
    });
    await statusPromise;

    let mockNow = realDateNow();
    Date.now = () => mockNow;
    mockNow += 30_000;

    const historyPromise = client.getHistory("conversation-1");
    assert.equal(FakeWebSocket.instances.length, 2);

    Date.now = realDateNow;

    const reconnectSocket = FakeWebSocket.instances[1];
    reconnectSocket.open();
    await waitFor(() => reconnectSocket.sent.length >= 1, "stale reconnect auth envelope");
    reconnectSocket.receive({
      id: reconnectSocket.sent[0].id,
      type: "response",
      payload: { ok: true },
    });
    await waitFor(
      () => reconnectSocket.sent.some((item) => item.type === "history.get"),
      "history request after stale reconnect",
    );

    const historyRequest = reconnectSocket.sent.find((item) => item.type === "history.get");
    assert.deepEqual(historyRequest.payload, {
      conversation_id: "conversation-1",
    });

    const payload = {
      conversation_id: "conversation-1",
      messages_json: "[]",
      total_message_count: 0,
      returned_message_count: 0,
      has_more: false,
    };
    reconnectSocket.receive({
      id: historyRequest.id,
      type: "response",
      payload,
    });

    assert.deepEqual(await historyPromise, payload);
  } finally {
    Date.now = realDateNow;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient reconnects before chat.start after a foreground restore", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const realDateNow = Date.now;
  try {
    const client = getGatewayWebSocketClient("token");
    const statusPromise = client.getStatus();
    const firstSocket = await connectAndAuth();
    await waitFor(() => firstSocket.sent.some((item) => item.type === "status.get"), "initial status.get");
    const statusRequest = firstSocket.sent.find((item) => item.type === "status.get");
    firstSocket.receive({
      id: statusRequest.id,
      type: "response",
      payload: { online: true, agent_id: "desktop-agent" },
    });
    await statusPromise;

    let mockNow = realDateNow();
    Date.now = () => mockNow;
    mockNow += 12_000;
    window.dispatchEvent({ type: "pageshow" });

    const stream = client.chat("hello", "conversation-1");
    const firstEventPromise = stream.next();
    assert.equal(firstSocket.readyState, FakeWebSocket.CLOSED);
    assert.equal(FakeWebSocket.instances.length, 2);

    Date.now = realDateNow;

    const reconnectSocket = FakeWebSocket.instances[1];
    reconnectSocket.open();
    await waitFor(() => reconnectSocket.sent.length >= 1, "foreground reconnect auth envelope");
    reconnectSocket.receive({
      id: reconnectSocket.sent[0].id,
      type: "response",
      payload: { ok: true },
    });
    await waitFor(
      () => reconnectSocket.sent.some((item) => item.type === "chat.start"),
      "chat.start after foreground reconnect",
    );
    const chatStart = reconnectSocket.sent.find((item) => item.type === "chat.start");
    assert.deepEqual(chatStart.payload.conversation_id, "conversation-1");

    reconnectSocket.receive({
      id: chatStart.id,
      type: "chat.control",
      payload: {
        type: "started",
        state: "running",
        conversation_id: "conversation-1",
        seq: 1,
      },
    });
    assert.deepEqual(await firstEventPromise, {
      value: {
        type: "started",
        state: "running",
        conversation_id: "conversation-1",
        seq: 1,
      },
      done: false,
    });
  } finally {
    Date.now = realDateNow;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient retries history.get after a recoverable transport stall timeout", async () => {
  const realSetTimeout = setTimeout;
  installBrowser({
    setTimeout: (fn, delay, ...args) =>
      realSetTimeout(fn, delay >= 30_000 ? 0 : delay, ...args),
  });
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const historyPromise = client.getHistory("conversation-1");
  const firstSocket = await connectAndAuth();
  await waitFor(
    () => firstSocket.sent.some((item) => item.type === "history.get"),
    "initial history.get envelope",
  );

  await waitFor(() => FakeWebSocket.instances.length === 2, "timeout recovery websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "timeout recovery auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "history.get"),
    "retried history.get envelope",
  );

  const historyRequest = reconnectSocket.sent.find((item) => item.type === "history.get");
  const payload = {
    conversation_id: "conversation-1",
    messages_json: "[]",
    total_message_count: 0,
    returned_message_count: 0,
    has_more: false,
  };
  reconnectSocket.receive({
    id: historyRequest.id,
    type: "response",
    payload,
  });

  assert.deepEqual(await historyPromise, payload);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient recovers chat.start when the socket stops receiving inbound traffic", async () => {
  const realSetTimeout = setTimeout;
  installBrowser({
    setTimeout: (fn, delay, ...args) =>
      realSetTimeout(fn, delay >= 8_000 ? 0 : delay, ...args),
  });
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.chat("hello", "conversation-1");
  const firstEventPromise = stream.next();
  const firstSocket = await connectAndAuth(0);
  await waitFor(() => firstSocket.sent.some((item) => item.type === "chat.start"), "chat.start envelope");
  const chatStart = firstSocket.sent.find((item) => item.type === "chat.start");

  await waitFor(() => FakeWebSocket.instances.length === 2, "chat.start transport recovery websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "chat.start recovery auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });

  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.resume"),
    "chat.start recovery resume envelope",
  );
  const resume = reconnectSocket.sent.find((item) => item.type === "chat.resume");
  assert.deepEqual(resume.payload, {
    request_id: chatStart.id,
    conversation_id: "conversation-1",
    after_seq: 0,
  });

  reconnectSocket.receive({
    id: chatStart.id,
    type: "error",
    error: "chat run not found",
  });
  assert.deepEqual(await firstEventPromise, {
    value: {
      type: "error",
      message: "chat run not found",
      conversation_id: "conversation-1",
    },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not open chat streams for pre-aborted signals", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const chatController = new AbortController();
  chatController.abort();
  const chatStream = client.chat("hello", "conversation-1", undefined, undefined, chatController.signal);
  assert.deepEqual(await chatStream.next(), { value: undefined, done: true });

  const attachController = new AbortController();
  attachController.abort();
  const attachStream = client.attachChat("conversation-1", { signal: attachController.signal });
  assert.deepEqual(await attachStream.next(), { value: undefined, done: true });

  assert.equal(FakeWebSocket.instances.length, 0);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient suppresses transient recoverable disconnect status errors", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusEvents = [];
  const unsubscribe = client.subscribeStatus((status, error) => {
    statusEvents.push({ status, error });
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((item) => item.type === "status.get"), "status envelope");
  const statusRequest = socket.sent.find((item) => item.type === "status.get");
  socket.receive({
    id: statusRequest.id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });
  await waitFor(
    () => statusEvents.some((event) => event.status?.online === true),
    "online status event",
  );

  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    statusEvents.some((event) =>
      String(event.error ?? "").includes("Gateway WebSocket disconnected"),
    ),
    false,
  );

  unsubscribe();
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient replies to gateway websocket pings", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth();
  socket.receive({
    type: "ping",
    payload: { timestamp: 123 },
  });
  await waitFor(() => socket.sent.some((item) => item.type === "pong"), "pong envelope");
  const pong = socket.sent.find((item) => item.type === "pong");
  assert.deepEqual(pong.payload, { timestamp: 123 });

  await waitFor(() => socket.sent.some((item) => item.type === "status.get"), "status envelope");
  const statusRequest = socket.sent.find((item) => item.type === "status.get");
  socket.receive({
    id: statusRequest.id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });
  await statusPromise;
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient chat generator yields scoped stream events until done", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.chat(
    "hello",
    "",
    { customProviderId: "claude-provider", model: "claude-test", providerType: "claude_code" },
    { executionMode: "agent-dev", workdir: "/workspace", selectedSystemTools: ["http_get_test"] },
    undefined,
    [
      {
        relativePath: "uploads/notes.txt",
        absolutePath: "/workspace/uploads/notes.txt",
        fileName: "notes.txt",
        kind: "text",
        sizeBytes: 12,
      },
      {
        relativePath: "uploads/screenshot.webp",
        absolutePath: "/workspace/uploads/screenshot.webp",
        fileName: "screenshot.webp",
        kind: "image",
        sizeBytes: 34,
      },
      {
        relativePath: "uploads/report.pdf",
        absolutePath: "/workspace/uploads/report.pdf",
        fileName: "report.pdf",
        kind: "pdf",
        sizeBytes: 56,
      },
    ],
    "client-submit-1",
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
    },
  );
  const firstEventPromise = stream.next();
  await waitFor(() => FakeWebSocket.instances.length === 1, "websocket construction");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "auth envelope");
  socket.receive({ id: socket.sent[0].id, type: "response", payload: { ok: true } });
  await waitFor(() => socket.sent.length >= 2, "chat.start envelope");

  const chatStart = socket.sent[1];
  assert.equal(chatStart.type, "chat.start");
  assert.equal(chatStart.payload.message, "hello");
  assert.equal(chatStart.payload.client_request_id, "client-submit-1");
  assert.equal(chatStart.payload.execution_mode, "agent-dev");
  assert.equal(chatStart.payload.workdir, "/workspace");
  assert.deepEqual(chatStart.payload.selected_system_tools, ["http_get_test"]);
  assert.deepEqual(chatStart.payload.selected_model, {
    custom_provider_id: "claude-provider",
    model: "claude-test",
    provider_type: "claude_code",
  });
  assert.deepEqual(chatStart.payload.runtime_controls, {
    thinking_enabled: false,
    native_web_search_enabled: true,
    reasoning: "xhigh",
  });
  assert.deepEqual(chatStart.payload.uploaded_files, [
    {
      relative_path: "uploads/notes.txt",
      absolute_path: "/workspace/uploads/notes.txt",
      file_name: "notes.txt",
      kind: "text",
      size_bytes: 12,
    },
    {
      relative_path: "uploads/screenshot.webp",
      absolute_path: "/workspace/uploads/screenshot.webp",
      file_name: "screenshot.webp",
      kind: "image",
      size_bytes: 34,
    },
    {
      relative_path: "uploads/report.pdf",
      absolute_path: "/workspace/uploads/report.pdf",
      file_name: "report.pdf",
      kind: "pdf",
      size_bytes: 56,
    },
  ]);

  socket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "token", text: "hi", conversation_id: "conversation-1" },
  });
  assert.deepEqual(await firstEventPromise, {
    value: { type: "token", text: "hi", conversation_id: "conversation-1" },
    done: false,
  });

  const donePromise = stream.next();
  socket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "done", conversation_id: "conversation-1" },
  });
  assert.deepEqual(await donePromise, {
    value: { type: "done", conversation_id: "conversation-1" },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });

  resetGatewayWebSocketClient();
});
