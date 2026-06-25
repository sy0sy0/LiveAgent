import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

test("live stream store commits through timer fallback when animation frames are paused", async () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const cancelledFrames = [];
  let requestedFrame = false;
  let notifications = 0;

  try {
    delete globalThis.document;
    globalThis.window = {
      requestAnimationFrame() {
        requestedFrame = true;
        return 11;
      },
      cancelAnimationFrame(frameId) {
        cancelledFrames.push(frameId);
      },
      setTimeout,
      clearTimeout,
    };

    const store = createLiveConversationStreamStore();
    store.subscribe(() => {
      notifications += 1;
    });
    store.appendEvent({
      type: "token",
      text: "hello",
      conversation_id: "conversation-1",
      round: 1,
    });

    assert.equal(store.getSnapshot().entries.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 310));

    const snapshot = store.getSnapshot();
    assert.equal(requestedFrame, true);
    assert.deepEqual(cancelledFrames, [11]);
    assert.equal(notifications, 1);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].kind, "assistant");
    assert.equal(snapshot.entries[0].text, "hello");
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test("runtime snapshot hydrates live entries and tool status", () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const store = createLiveConversationStreamStore();

  store.applySnapshot(
    {
      type: "runtime_snapshot",
      seq: 3,
      revision: 1,
      entries_json: JSON.stringify([
        { id: "u1", kind: "user", text: "hello", attachments: [] },
        { id: "a1", kind: "assistant", text: "partial", round: 1 },
      ]),
      tool_status: "Thinking...",
      tool_status_is_compaction: true,
    },
    { flush: true },
  );

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].kind, "user");
  assert.equal(snapshot.entries[1].kind, "assistant");
  assert.equal(snapshot.entries[1].text, "partial");
  assert.equal(snapshot.toolStatus, "Thinking...");
  assert.equal(snapshot.toolStatusIsCompaction, true);
});

test("runtime snapshot ignores checkpoint history entries", () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const store = createLiveConversationStreamStore();

  store.applySnapshot(
    {
      type: "runtime_snapshot",
      seq: 4,
      revision: 1,
      entries_json: JSON.stringify([
        {
          id: "summary-1",
          kind: "checkpoint",
          content: "old summary",
          summaryId: "summary-1",
          coveredMessageCount: 10,
          coversThroughMessageId: "m10",
          generatedBy: { providerId: "p", model: "m" },
        },
        { id: "a1", kind: "assistant", text: "partial", round: 1 },
      ]),
    },
    { flush: true },
  );

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].kind, "assistant");
  assert.equal(snapshot.entries[0].text, "partial");
});

test("runtime snapshot ignores older revisions", () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const store = createLiveConversationStreamStore();

  store.applySnapshot(
    {
      type: "runtime_snapshot",
      seq: 5,
      revision: 2,
      entries_json: JSON.stringify([{ id: "a1", kind: "assistant", text: "new", round: 1 }]),
    },
    { flush: true },
  );
  store.applySnapshot(
    {
      type: "runtime_snapshot",
      seq: 6,
      revision: 1,
      entries_json: JSON.stringify([{ id: "a1", kind: "assistant", text: "old", round: 1 }]),
    },
    { flush: true },
  );

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].text, "new");
});

test("runtime snapshot fences old deltas and accepts newer stream events", () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const store = createLiveConversationStreamStore();

  store.applySnapshot(
    {
      type: "runtime_snapshot",
      seq: 10,
      revision: 1,
      entries_json: JSON.stringify([{ id: "a1", kind: "assistant", text: "partial", round: 1 }]),
    },
    { flush: true },
  );
  store.appendEvent(
    {
      type: "token",
      seq: 8,
      text: " stale",
      conversation_id: "conversation-1",
      round: 1,
    },
    { flush: true },
  );
  assert.equal(store.getSnapshot().entries[0].text, "partial");

  store.appendEvent(
    {
      type: "token",
      seq: 11,
      text: " fresh",
      conversation_id: "conversation-1",
      round: 1,
    },
    { flush: true },
  );
  assert.equal(store.getSnapshot().entries[0].text, "partial fresh");
});
