import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { isGitWorktreeBranchNotFullyMergedError } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/git/types.ts",
);

test("recognizes an unmerged branch failure after worktree removal", () => {
  assert.equal(
    isGitWorktreeBranchNotFullyMergedError(
      "Worktree 已移除，但分支删除失败：error: The branch 'feature' is not fully merged.",
    ),
    true,
  );
});

test("does not classify dirty worktree removal as an unmerged branch failure", () => {
  assert.equal(
    isGitWorktreeBranchNotFullyMergedError(
      "fatal: contains modified or untracked files, use --force to delete it",
    ),
    false,
  );
});
