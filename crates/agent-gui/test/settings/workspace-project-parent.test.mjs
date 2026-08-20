import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("normalizeSystemSettings keeps workspace project groups", () => {
  const normalized = settings.normalizeSystemSettings({
    workspaceProjectGroups: [
      {
        id: "g1",
        name: "Repo",
        projectPaths: ["/work/repo", "/work/repo/worktrees/a"],
        sourceProjectPath: "/work/repo",
        collapsed: true,
        createdAt: 100,
        updatedAt: 100,
      },
    ],
  });
  assert.equal(normalized.workspaceProjectGroups.length, 1);
  assert.equal(normalized.workspaceProjectGroups[0].name, "Repo");
  assert.deepEqual(normalized.workspaceProjectGroups[0].projectPaths, [
    "/work/repo",
    "/work/repo/worktrees/a",
  ]);
  assert.equal(normalized.workspaceProjectGroups[0].sourceProjectPath, "/work/repo");
  assert.equal(normalized.workspaceProjectGroups[0].collapsed, true);
});

test("normalizeSystemSettings drops invalid group entries and dedupes paths", () => {
  const normalized = settings.normalizeSystemSettings({
    workspaceProjectGroups: [
      {
        id: "g1",
        name: "Group",
        projectPaths: ["/work/a", "/work/a/", "   ", 42],
        createdAt: 100,
        updatedAt: 100,
      },
      { id: "g1", name: "Duplicate id", projectPaths: [], createdAt: 100, updatedAt: 100 },
      { name: "Missing id", projectPaths: [], createdAt: 100, updatedAt: 100 },
    ],
  });
  assert.equal(normalized.workspaceProjectGroups.length, 2);
  assert.deepEqual(normalized.workspaceProjectGroups[0].projectPaths, ["/work/a"]);
});

test("legacy settings without groups normalize to an empty list", () => {
  const normalized = settings.normalizeSystemSettings({});
  assert.deepEqual(normalized.workspaceProjectGroups, []);
});
