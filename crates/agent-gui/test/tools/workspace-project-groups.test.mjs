import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  assignWorkspaceProjectToGroup,
  ensureWorktreeProjectGroup,
  buildWorkspaceProjectSections,
  firstUnpinnedWorkspaceProjectIndex,
  removeWorkspaceProjectFromGroups,
  sliceWorkspaceProjectSections,
} = loader.loadModule("@liveagent/ui/lib/workspaceProjects.ts");
function project(id, path, extra = {}) {
  return {
    id,
    name: id,
    path,
    kind: "managed",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function group(id, name, projectPaths = [], extra = {}) {
  return {
    id,
    name,
    projectPaths,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

test("assignWorkspaceProjectToGroup moves a project between groups", () => {
  const groups = [
    group("g1", "Alpha", ["/work/a"]),
    group("g2", "Beta", ["/work/b"]),
  ];
  const next = assignWorkspaceProjectToGroup(groups, "g2", "/work/a");
  assert.deepEqual(
    next.map((g) => [g.id, g.projectPaths]),
    [
      ["g1", []],
      ["g2", ["/work/b", "/work/a"]],
    ],
  );
});

test("assignWorkspaceProjectToGroup is idempotent for the target group", () => {
  const groups = [group("g1", "Alpha", ["/work/a"])];
  const next = assignWorkspaceProjectToGroup(groups, "g1", "/work/a");
  assert.deepEqual(next.map((g) => [g.id, g.projectPaths]), [["g1", ["/work/a"]]]);
});

test("removeWorkspaceProjectFromGroups removes normalized paths from every group", () => {
  const groups = [
    group("g1", "Alpha", ["/work/a/", "/work/b"]),
    group("g2", "Beta", ["/work/a"]),
  ];
  const next = removeWorkspaceProjectFromGroups(groups, "/work/a");
  assert.deepEqual(
    next.map((item) => [item.id, item.projectPaths]),
    [
      ["g1", ["/work/b"]],
      ["g2", []],
    ],
  );
});

test("removeWorkspaceProjectFromGroups preserves identity when no group contains the path", () => {
  const groups = [group("g1", "Alpha", ["/work/a"])];
  assert.equal(removeWorkspaceProjectFromGroups(groups, "/work/b"), groups);
});

test("ensureWorktreeProjectGroup reuses the group by sourceProjectPath after rename", () => {
  const renamed = group("g1", "用户改名后的组", ["/work/repo"], {
    sourceProjectPath: "/work/repo",
  });
  const ensured = ensureWorktreeProjectGroup([renamed], {
    name: "repo",
    sourceProjectPath: "/work/repo",
  });
  assert.equal(ensured.groupId, "g1");
  assert.equal(ensured.groups.length, 1);
});

test("ensureWorktreeProjectGroup creates a new group for a new source", () => {
  const ensured = ensureWorktreeProjectGroup([], {
    name: "repo",
    sourceProjectPath: "/work/repo",
  });
  assert.ok(ensured.groupId);
  assert.equal(ensured.groups.length, 1);
  assert.equal(ensured.groups[0].name, "repo");
  assert.equal(ensured.groups[0].sourceProjectPath, "/work/repo");
});

test("buildWorkspaceProjectSections groups members under their section", () => {
  const repo = project("repo", "/work/repo");
  const worktree = project("wt", "/work/wt");
  const other = project("other", "/work/other");
  const sections = buildWorkspaceProjectSections(
    [repo, worktree, other],
    [group("g1", "repo", ["/work/repo", "/work/wt"])],
  );
  assert.deepEqual(
    sections.grouped.map((s) => [s.group.id, s.projects.map((p) => p.id)]),
    [["g1", ["repo", "wt"]]],
  );
  assert.deepEqual(sections.ungrouped.map((p) => p.id), ["other"]);
});

test("buildWorkspaceProjectSections orders sections by earliest member index", () => {
  const repo = project("repo", "/work/repo");
  const activeWt = project("wt", "/work/wt");
  const middle = project("middle", "/work/middle");
  // 子项目更活跃 → 输入列表中下标更小 → 整组提前
  const sections = buildWorkspaceProjectSections(
    [activeWt, repo, middle],
    [
      group("g1", "repo", ["/work/repo", "/work/wt"]),
      group("g2", "middle", ["/work/middle"]),
    ],
  );
  assert.deepEqual(
    sections.grouped.map((s) => s.group.id),
    ["g1", "g2"],
  );
});

test("buildWorkspaceProjectSections ignores members missing from the list", () => {
  const repo = project("repo", "/work/repo");
  const sections = buildWorkspaceProjectSections(
    [repo],
    [group("g1", "repo", ["/work/repo", "/gone/worktree"])],
  );
  assert.deepEqual(sections.grouped[0].projects.map((p) => p.id), ["repo"]);
});

test("firstUnpinnedWorkspaceProjectIndex marks the divider inside ungrouped projects", () => {
  const pinned = project("pinned", "/work/pinned", { isPinned: true, pinnedAt: 2 });
  const regular = project("regular", "/work/regular");
  assert.equal(firstUnpinnedWorkspaceProjectIndex([pinned, regular]), 1);
  assert.equal(firstUnpinnedWorkspaceProjectIndex([regular, pinned]), -1);
  assert.equal(firstUnpinnedWorkspaceProjectIndex([pinned]), -1);
});

test("sliceWorkspaceProjectSections never splits a group", () => {
  const repo = project("repo", "/work/repo");
  const wt = project("wt", "/work/wt");
  const a = project("a", "/work/a");
  const b = project("b", "/work/b");
  const sections = buildWorkspaceProjectSections(
    [repo, wt, a, b],
    [
      group("g1", "repo", ["/work/repo", "/work/wt"]),
      group("g2", "a", ["/work/a"]),
      group("g3", "b", ["/work/b"]),
    ],
  );
  // g1 有 2 个成员，超出上限 1 时整组都放不下 → 整组隐藏，绝不拆开。
  const sliced = sliceWorkspaceProjectSections(sections, 1);
  assert.equal(sliced.sections.grouped.length, 0);
  assert.equal(sliced.sections.ungrouped.length, 0);
  assert.equal(sliced.hiddenProjectCount, 4);
});

test("sliceWorkspaceProjectSections caps ungrouped projects", () => {
  const projects = [0, 1, 2, 3, 4].map((index) =>
    project(`p${index}`, `/work/p${index}`),
  );
  const sections = buildWorkspaceProjectSections(projects, []);
  const sliced = sliceWorkspaceProjectSections(sections, 2);
  assert.deepEqual(
    sliced.sections.ungrouped.map((p) => p.id),
    ["p0", "p1"],
  );
  assert.equal(sliced.hiddenProjectCount, 3);
});

test("sliceWorkspaceProjectSections fills remaining capacity with ungrouped", () => {
  const repo = project("repo", "/work/repo");
  const wt = project("wt", "/work/wt");
  const a = project("a", "/work/a");
  const b = project("b", "/work/b");
  const sections = buildWorkspaceProjectSections(
    [repo, wt, a, b],
    [group("g1", "repo", ["/work/repo", "/work/wt"])],
  );
  // g1 占 2 个名额，上限 4 的剩余 2 个分给未分组项目。
  const sliced = sliceWorkspaceProjectSections(sections, 4);
  assert.equal(sliced.sections.grouped.length, 1);
  assert.equal(sliced.sections.grouped[0].projects.length, 2);
  assert.deepEqual(
    sliced.sections.ungrouped.map((p) => p.id),
    ["a", "b"],
  );
  assert.equal(sliced.hiddenProjectCount, 0);
});

test("single project belongs to exactly one group at a time", () => {
  const groups = [
    group("g1", "Alpha", ["/work/a"]),
    group("g2", "Beta", []),
  ];
  const moved = assignWorkspaceProjectToGroup(groups, "g2", "/work/a");
  const counts = moved.map(
    (g) => g.projectPaths.filter((p) => p === "/work/a").length,
  );
  assert.deepEqual(counts, [0, 1]);
});
