/**
 * 侧边栏项目分组。成员用原始路径存储（匹配时经
 * `workspaceProjectPathKey` 归一化），与 hidden/missing/archived 一致。
 *
 * `sourceProjectPath` 标记自动分组（git worktree 聚合）：指向原始仓库
 * 项目的路径，重命名分组后仍可据此复用，避免重复建组。
 */
export type WorkspaceProjectGroup = {
  id: string;
  name: string;
  projectPaths: string[];
  sourceProjectPath?: string;
  collapsed?: boolean;
  createdAt: number;
  updatedAt: number;
};
