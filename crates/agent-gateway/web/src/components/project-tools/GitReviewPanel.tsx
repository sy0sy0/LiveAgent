import { DiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { computeGitGraph, GRAPH_COLORS, type GraphRow } from "../../lib/git/gitGraph";
import type {
  GitClient,
  GitCommitFile,
  GitCommitSummary,
  GitDiffResponse,
  GitRepositoryState,
  GitStatusEntry,
} from "../../lib/git/types";
import { emptyGitRepositoryState } from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import { getFileTypeIcon } from "../chat/fileTypeIcons";
import {
  BrushCleaning,
  Eye,
  FilePenLine,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const LARGE_DIFF_CHUNK_CHAR_LIMIT = 120 * 1024;
const LARGE_DIFF_CHUNK_LINE_LIMIT = 1800;
const RAW_DIFF_PREVIEW_CHAR_LIMIT = 60 * 1024;
const INITIAL_CHANGE_ENTRY_RENDER_COUNT = 160;
const CHANGE_ENTRY_RENDER_BATCH_SIZE = 160;

type PatchChunk = {
  key: string;
  label: string;
  chunk: string;
  lineCount: number;
  large: boolean;
};

type DiffStatFile = {
  key: string;
  path: string;
  changes: number | null;
  additions: number;
  deletions: number;
  additionPercent: number;
  deletionPercent: number;
  binary: boolean;
  raw: string;
};

type DiffStatSummary = {
  raw?: string;
};

type ParsedDiffStat = {
  files: DiffStatFile[];
  fallbackLines: string[];
  summary: DiffStatSummary;
};

type DiffViewKind = "branch" | "workingTree";
type GitReviewMode = "changes" | "history";
type GitHistoryRow =
  | {
      type: "commit";
      commit: GitCommitSummary;
      commitIndex: number;
    }
  | {
      type: "file";
      commit: GitCommitSummary;
      commitIndex: number;
      file: GitCommitFile;
    };

type ChangeContextMenuState = {
  x: number;
  y: number;
  path: string;
};

type ChangesMenuState = {
  x: number;
  y: number;
};

const CHANGE_CONTEXT_MENU_WIDTH = 232;
const CHANGE_CONTEXT_MENU_HEIGHT = 210;
const CHANGES_MENU_WIDTH = 232;
const CHANGES_MENU_HEIGHT = 170;
const GIT_HISTORY_LIMIT = 120;
const CHANGE_CONTEXT_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45";
const GIT_REVIEW_POLL_INTERVAL_MS = 1500;

type GitRefreshOptions = {
  force?: boolean;
  notifyChanged?: boolean;
  silent?: boolean;
};

function dispatchGitChanged(workdir: string) {
  window.dispatchEvent(
    new CustomEvent("liveagent:git-changed", {
      detail: { workdir },
    }),
  );
}

function useIsDark() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function splitPatchByFile(patch: string) {
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((line) => line.trim() !== "")) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

function cleanDiffPath(value: string) {
  if (!value || value === "/dev/null") return "";
  return value.replace(/^[ab]\//, "");
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized || "Untitled";
}

function parentPath(path: string) {
  return dirname(path) || ".";
}

function getPatchFileNames(chunk: string, fallback: string) {
  const lines = chunk.split("\n");
  const gitHeader = lines.find((line) => line.startsWith("diff --git "));
  if (gitHeader) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(gitHeader);
    if (match) {
      return {
        oldFileName: cleanDiffPath(match[1] ?? "") || fallback,
        newFileName: cleanDiffPath(match[2] ?? "") || fallback,
      };
    }
  }
  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  return {
    oldFileName: cleanDiffPath(oldHeader?.slice(4).trim() ?? "") || fallback,
    newFileName: cleanDiffPath(newHeader?.slice(4).trim() ?? "") || fallback,
  };
}

function countLines(value: string) {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function parseDiffStatFile(line: string, index: number): DiffStatFile | null {
  const pipeIndex = line.lastIndexOf("|");
  if (pipeIndex < 0) return null;
  const path = line.slice(0, pipeIndex).trim();
  const details = line.slice(pipeIndex + 1).trim();
  if (!path || !details) return null;

  const binary = /^Bin\b/.test(details);
  if (binary) {
    return {
      key: `${path}:${index}`,
      path,
      changes: null,
      additions: 0,
      deletions: 0,
      additionPercent: 0,
      deletionPercent: 0,
      binary: true,
      raw: line,
    };
  }

  const match = /^(\d+)\s*([+\-]*)/.exec(details);
  if (!match?.[1]) return null;
  const changes = Number(match[1]);
  if (!Number.isFinite(changes)) return null;
  const graph = match[2] ?? "";
  const graphAdditions = graph.split("").filter((char) => char === "+").length;
  const graphDeletions = graph.split("").filter((char) => char === "-").length;
  const graphUnits = graphAdditions + graphDeletions;
  const additions = graphUnits > 0 ? Math.round(changes * (graphAdditions / graphUnits)) : 0;
  const deletions = graphUnits > 0 ? Math.max(0, changes - additions) : 0;
  const total = additions + deletions;
  const additionPercent = total > 0 ? (additions / total) * 100 : 0;
  const deletionPercent = total > 0 ? (deletions / total) * 100 : 0;

  return {
    key: `${path}:${index}`,
    path,
    changes,
    additions,
    deletions,
    additionPercent,
    deletionPercent,
    binary: false,
    raw: line,
  };
}

function parseDiffStat(stat: string): ParsedDiffStat {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const hasSummary =
    /\bfiles? changed\b/.test(lastLine) ||
    /\binsertions?\(\+\)/.test(lastLine) ||
    /\bdeletions?\(-\)/.test(lastLine);
  const summary: DiffStatSummary = hasSummary
    ? {
        raw: lastLine,
      }
    : {};
  const fileLines = hasSummary ? lines.slice(0, -1) : lines;
  const files: DiffStatFile[] = [];
  const fallbackLines: string[] = [];
  fileLines.forEach((line, index) => {
    const file = parseDiffStatFile(line, index);
    if (file) {
      files.push(file);
    } else {
      fallbackLines.push(line);
    }
  });
  return { files, fallbackLines, summary };
}

function buildPatchChunks(patch: string, title: string): PatchChunk[] {
  if (!patch.trim()) return [];
  return splitPatchByFile(patch).map((chunk, index) => {
    const names = getPatchFileNames(chunk, `${title}-${index + 1}`);
    const label = names.newFileName || names.oldFileName || `${title} ${index + 1}`;
    const lineCount = countLines(chunk);
    return {
      key: `${names.oldFileName}:${names.newFileName}:${index}`,
      label,
      chunk,
      lineCount,
      large:
        chunk.length > LARGE_DIFF_CHUNK_CHAR_LIMIT ||
        lineCount > LARGE_DIFF_CHUNK_LINE_LIMIT,
    };
  });
}

const DiffChunkView = memo(function DiffChunkView(props: {
  item: PatchChunk;
  isDark: boolean;
}) {
  const { item, isDark } = props;
  const { t } = useLocale();
  const diffFile = useMemo(() => {
    if (item.large) return null;
    try {
      const names = getPatchFileNames(item.chunk, item.label);
      const instance = new DiffFile(
        names.oldFileName,
        "",
        names.newFileName,
        "",
        [item.chunk],
        "diff",
        "diff",
      );
      instance.initTheme(isDark ? "dark" : "light");
      instance.init();
      instance.buildUnifiedDiffLines();
      return instance;
    } catch {
      return null;
    }
  }, [isDark, item]);

  const rawPreview = useMemo(() => {
    if (!item.large) return item.chunk;
    return item.chunk.length > RAW_DIFF_PREVIEW_CHAR_LIMIT
      ? `${item.chunk.slice(0, RAW_DIFF_PREVIEW_CHAR_LIMIT)}\n\n${t("projectTools.gitReview.diffPreviewTruncated")}`
      : item.chunk;
  }, [item, t]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.large ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {t("projectTools.gitReview.largeDiff")}
          </span>
        ) : null}
      </div>
      {diffFile ? (
        <DiffView
          diffFile={diffFile}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap={false}
          diffViewFontSize={12}
        />
      ) : (
        <pre className="max-h-[26rem] overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {rawPreview}
        </pre>
      )}
    </div>
  );
});

function DiffStatView(props: { stat: string }) {
  const { stat } = props;
  const { t } = useLocale();
  const parsed = useMemo(() => parseDiffStat(stat), [stat]);
  if (!stat.trim()) return null;

  const showStructured = parsed.files.length > 0;

  if (!showStructured) {
    return (
      <pre className="max-h-24 overflow-auto border-b border-border/70 bg-muted/25 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {stat}
      </pre>
    );
  }

  return (
    <div className="border-b border-border/70 bg-muted/10 px-3 py-2">
      {parsed.files.length > 0 ? (
        <div className="max-h-40 overflow-auto space-y-1">
          {parsed.files.map((file) => (
            <div
              key={file.key}
              className="rounded-md border border-border/60 bg-background/75 px-2.5 py-2"
              title={file.raw}
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                  {basename(file.path)}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                  {file.binary ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {t("projectTools.gitReview.statBinary")}
                    </span>
                  ) : (
                    <>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {file.changes} {t("projectTools.gitReview.statChanges")}
                      </span>
                      {file.additions > 0 ? (
                        <span
                          className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300"
                          title={t("projectTools.gitReview.statInsertions")}
                        >
                          +{file.additions}
                        </span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span
                          className="rounded-full bg-rose-500/10 px-1.5 py-0.5 font-semibold text-rose-700 dark:text-rose-300"
                          title={t("projectTools.gitReview.statDeletions")}
                        >
                          -{file.deletions}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
                  {file.additions > 0 ? (
                    <span
                      className="h-full bg-emerald-500/75"
                      style={{ width: `${file.additionPercent}%` }}
                    />
                  ) : null}
                  {file.deletions > 0 ? (
                    <span
                      className="h-full bg-rose-500/75"
                      style={{ width: `${file.deletionPercent}%` }}
                    />
                  ) : null}
                  {!file.binary && file.additions + file.deletions === 0 ? (
                    <span className="h-full w-full bg-muted-foreground/25" />
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.fallbackLines.length > 0 ? (
        <pre className="mt-2 max-h-20 overflow-auto rounded-md bg-muted/35 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {parsed.fallbackLines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

function DiffContent(props: { diff?: GitDiffResponse | null; title: string; error?: string }) {
  const { diff, title, error } = props;
  const { t } = useLocale();
  const isDark = useIsDark();
  const patchChunks = useMemo(
    () => buildPatchChunks(diff?.patch ?? "", title),
    [diff?.patch, title],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {error ? <div className="shrink-0 px-3 py-3 text-xs text-destructive">{error}</div> : null}
      {!error && diff?.stat ? (
        <DiffStatView stat={diff.stat} />
      ) : null}
      {!error && patchChunks.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {patchChunks.map((item) => (
            <DiffChunkView key={item.key} item={item} isDark={isDark} />
          ))}
        </div>
      ) : null}
      {!error && diff?.patch.trim() && patchChunks.length === 0 ? (
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {diff.patch}
        </pre>
      ) : null}
      {!error && !diff?.patch.trim() && patchChunks.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8 text-center text-xs text-muted-foreground">
          {t("projectTools.gitReview.noDiff")}
        </div>
      ) : null}
      {diff?.truncated ? (
        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
          {t("projectTools.gitReview.diffOutputTruncated")}
        </div>
      ) : null}
    </div>
  );
}

function DiffReviewCard(props: {
  activeView: DiffViewKind;
  branchDiff?: GitDiffResponse | null;
  branchError?: string;
  diffLoading?: boolean;
  onActiveViewChange: (view: DiffViewKind) => void;
  worktreeDiff?: GitDiffResponse | null;
}) {
  const {
    activeView,
    branchDiff,
    branchError,
    diffLoading,
    onActiveViewChange,
    worktreeDiff,
  } = props;
  const { t } = useLocale();
  const activeDiff = activeView === "branch" ? branchDiff : worktreeDiff;
  const branchTitle = t("projectTools.gitReview.branchDiff");
  const workingTreeTitle = t("projectTools.gitReview.workingTree");
  const activeTitle = activeView === "branch" ? branchTitle : workingTreeTitle;
  const activeError = activeView === "branch" ? branchError : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{activeTitle}</div>
          {activeDiff ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {activeDiff.baseRef} → {activeDiff.headRef}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diffLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <Button
            type="button"
            size="sm"
            variant={activeView === "workingTree" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={workingTreeTitle}
            aria-label={t("projectTools.gitReview.showWorkingTree")}
            onClick={() => onActiveViewChange("workingTree")}
          >
            <FolderTree className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeView === "branch" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={branchTitle}
            aria-label={t("projectTools.gitReview.showBranchDiff")}
            onClick={() => onActiveViewChange("branch")}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <DiffContent title={activeTitle} diff={activeDiff} error={activeError} />
    </section>
  );
}

function statusTone(entry: GitStatusEntry) {
  if (entry.conflicted) return "text-destructive";
  if (entry.untracked) return "text-sky-600 dark:text-sky-300";
  if (entry.staged) return "text-emerald-600 dark:text-emerald-300";
  return "text-amber-600 dark:text-amber-300";
}

function statusLabel(entry: GitStatusEntry) {
  if (entry.conflicted) return "U";
  if (entry.untracked) return "U";
  const statuses = [entry.indexStatus, entry.worktreeStatus].filter((status) => status && status !== ".");
  if (entry.kind === "renamed" || statuses.includes("R")) return "R";
  if (statuses.includes("D")) return "D";
  if (statuses.includes("A")) return "A";
  if (statuses.includes("M") || statuses.includes("T")) return "M";
  return statuses[0] ?? "";
}

function commitFileStatusTone(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  if (status === "A") return "text-emerald-600 dark:text-emerald-300";
  if (status === "D") return "text-rose-600 dark:text-rose-300";
  if (status === "R" || status === "C") return "text-sky-600 dark:text-sky-300";
  return "text-amber-600 dark:text-amber-300";
}

function commitFileStatusLabel(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  return status === "R" || status === "C" || status === "A" || status === "D" ? status : "M";
}

const GRAPH_COL_WIDTH = 16;
const GRAPH_ROW_HEIGHT = 28;
const GRAPH_DOT_Y = 14;
const GRAPH_DOT_R = 3.5;
const GRAPH_LINE_W = 2;

function graphLayoutWidth(row: GraphRow) {
  return graphDrawWidth(row);
}

function graphDrawWidth(row: GraphRow) {
  const maxPipeCol = Math.max(
    row.commitCol,
    ...row.topPipes.flatMap((pipe) => [pipe.fromCol, pipe.toCol]),
    ...row.bottomPipes.flatMap((pipe) => [pipe.fromCol, pipe.toCol]),
  );
  return (maxPipeCol + 1) * GRAPH_COL_WIDTH;
}

function graphContinuationWidth(row: GraphRow) {
  const maxPipeCol = Math.max(
    row.commitCol,
    ...row.bottomPipes.flatMap((pipe) => [pipe.fromCol, pipe.toCol]),
  );
  return (maxPipeCol + 1) * GRAPH_COL_WIDTH;
}

function graphLaneX(col: number) {
  return col * GRAPH_COL_WIDTH + GRAPH_COL_WIDTH / 2;
}

function graphCurvePath(x1: number, y1: number, x2: number, y2: number) {
  const handle = Math.min(10, Math.abs(y2 - y1) * 0.72);
  return `M${x1} ${y1}C${x1} ${y1 + handle},${x2} ${y2 - handle},${x2} ${y2}`;
}

function GitGraphSvgCell({
  row,
  isFirst,
  isLast,
}: {
  row: GraphRow;
  isFirst: boolean;
  isLast: boolean;
}) {
  const drawW = graphDrawWidth(row);
  const layoutW = graphLayoutWidth(row);
  const cx = graphLaneX(row.commitCol);

  return (
    <div className="h-7 shrink-0 overflow-visible" style={{ width: layoutW, minWidth: layoutW }}>
      <svg
        width={drawW}
        height={GRAPH_ROW_HEIGHT}
        className="block overflow-visible"
        aria-hidden="true"
        style={{ shapeRendering: "geometricPrecision" }}
      >
        {row.topPipes.map((pipe, index) => {
          const x1 = graphLaneX(pipe.fromCol);
          const x2 = graphLaneX(pipe.toCol);
          const color = GRAPH_COLORS[pipe.color % GRAPH_COLORS.length];
          if (isFirst) return null;
          if (x1 === x2) {
            return (
              <line
                key={`t${index}`}
                x1={x1}
                y1={0}
                x2={x2}
                y2={GRAPH_DOT_Y}
                stroke={color}
                strokeLinecap="round"
                strokeWidth={GRAPH_LINE_W}
              />
            );
          }
          return (
            <path
              key={`t${index}`}
              d={graphCurvePath(x1, 0, x2, GRAPH_DOT_Y)}
              fill="none"
              stroke={color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={GRAPH_LINE_W}
            />
          );
        })}

        {row.bottomPipes.map((pipe, index) => {
          const x1 = graphLaneX(pipe.fromCol);
          const x2 = graphLaneX(pipe.toCol);
          const color = GRAPH_COLORS[pipe.color % GRAPH_COLORS.length];
          if (isLast) return null;
          if (x1 === x2) {
            return (
              <line
                key={`b${index}`}
                x1={x1}
                y1={GRAPH_DOT_Y}
                x2={x2}
                y2={GRAPH_ROW_HEIGHT}
                stroke={color}
                strokeLinecap="round"
                strokeWidth={GRAPH_LINE_W}
              />
            );
          }
          return (
            <path
              key={`b${index}`}
              d={graphCurvePath(x1, GRAPH_DOT_Y, x2, GRAPH_ROW_HEIGHT)}
              fill="none"
              stroke={color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={GRAPH_LINE_W}
            />
          );
        })}

        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R}
          fill={GRAPH_COLORS[row.commitColor % GRAPH_COLORS.length]}
          stroke="var(--background)"
          strokeWidth={2}
        />
      </svg>
    </div>
  );
}

function GitGraphContinuationCell({ row, isLast }: { row: GraphRow; isLast: boolean }) {
  const layoutW = graphContinuationWidth(row);
  const pipes = isLast ? [] : row.bottomPipes;

  return (
    <div
      className="relative shrink-0 self-stretch overflow-visible"
      style={{ width: layoutW, minWidth: layoutW }}
      aria-hidden="true"
    >
      {pipes.map((pipe, index) => {
        const x = graphLaneX(pipe.toCol);
        return (
          <span
            key={`c${index}:${pipe.toCol}:${pipe.color}`}
            className="absolute bottom-0 top-0"
            style={{
              backgroundColor: GRAPH_COLORS[pipe.color % GRAPH_COLORS.length],
              left: x - GRAPH_LINE_W / 2,
              width: GRAPH_LINE_W,
            }}
          />
        );
      })}
    </div>
  );
}

function formatCommitDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function canStageEntry(entry: GitStatusEntry) {
  return entry.untracked || entry.conflicted || entry.worktreeStatus !== ".";
}

function revealTargetForEntry(entry: GitStatusEntry) {
  if (!entry.untracked && (entry.indexStatus === "D" || entry.worktreeStatus === "D")) {
    return dirname(entry.oldPath ?? entry.path);
  }
  return entry.path;
}

function gitRepositoryStateSignature(state: GitRepositoryState) {
  const dirty = state.dirtyCounts;
  const header = [
    state.status,
    state.error ?? "",
    state.repoRoot,
    state.workdir,
    state.head,
    state.upstream,
    state.ahead,
    state.behind,
    dirty.staged,
    dirty.unstaged,
    dirty.untracked,
    dirty.conflicted,
  ].join("\x1f");
  const entries = state.entries
    .map((entry) =>
      [
        entry.path,
        entry.oldPath ?? "",
        entry.indexStatus,
        entry.worktreeStatus,
        entry.kind,
        entry.staged ? "1" : "0",
        entry.conflicted ? "1" : "0",
        entry.untracked ? "1" : "0",
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${header}\x1d${entries}`;
}

function gitHistorySignature(state: GitRepositoryState, commits: GitCommitSummary[]) {
  const commitsSignature = commits
    .map((commit) =>
      [
        commit.sha,
        commit.parents.join(","),
        commit.refs.join(","),
        commit.authorDate,
        commit.subject,
        commit.fileCount,
        commit.files
          .map((file) => [file.path, file.oldPath ?? "", file.status, file.kind].join("\x1e"))
          .join("\x1c"),
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${gitRepositoryStateSignature(state)}\x1d${commitsSignature}`;
}

function gitDiffSignature(diff: GitDiffResponse) {
  return [
    diff.baseRef,
    diff.headRef,
    diff.mode,
    diff.files.join("\x1e"),
    diff.binaryFiles.join("\x1e"),
    diff.truncated ? "1" : "0",
    diff.stat,
    diff.patch,
  ].join("\x1f");
}

function assertGitOperationResult(value: unknown, fallbackMessage: string) {
  if (!value || typeof value !== "object") return;
  const result = value as { ok?: unknown; message?: unknown; stderr?: unknown };
  if (result.ok === false) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message
        : typeof result.stderr === "string" && result.stderr.trim()
          ? result.stderr
          : fallbackMessage;
    throw new Error(message);
  }
}

export function GitReviewPanel(props: {
  cwd: string;
  gitClient?: GitClient | null;
  canWrite?: boolean;
  disabledMessage?: string;
  onRevealInFileTree?: (path: string) => void;
}) {
  const { cwd, gitClient, canWrite = true, disabledMessage, onRevealInFileTree } = props;
  const { t } = useLocale();
  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(cwd));
  const [branchDiff, setBranchDiff] = useState<GitDiffResponse | null>(null);
  const [worktreeDiff, setWorktreeDiff] = useState<GitDiffResponse | null>(null);
  const [branchError, setBranchError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [activeDiffView, setActiveDiffView] = useState<DiffViewKind>("workingTree");
  const [reviewMode, setReviewMode] = useState<GitReviewMode>("changes");
  const [historyCommits, setHistoryCommits] = useState<GitCommitSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedCommitSha, setSelectedCommitSha] = useState("");
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState("");
  const [expandedCommitSha, setExpandedCommitSha] = useState("");
  const [commitDiff, setCommitDiff] = useState<GitDiffResponse | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [changeContextMenu, setChangeContextMenu] = useState<ChangeContextMenuState | null>(null);
  const [changesMenu, setChangesMenu] = useState<ChangesMenuState | null>(null);
  const selectedPathRef = useRef("");
  const selectedCommitShaRef = useRef("");
  const selectedCommitFilePathRef = useRef("");
  const expandedCommitShaRef = useRef("");
  const reviewModeRef = useRef<GitReviewMode>("changes");
  const diffRequestIdRef = useRef(0);
  const diffInFlightRequestIdRef = useRef(0);
  const commitDiffRequestIdRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const statusSignatureRef = useRef("");
  const historySignatureRef = useRef("");
  const branchDiffSignatureRef = useRef("");
  const worktreeDiffSignatureRef = useRef("");
  const refreshInFlightRef = useRef(false);
  const historyInFlightRef = useRef(false);
  const suppressNextGitChangedRef = useRef(false);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    reviewModeRef.current = reviewMode;
  }, [reviewMode]);

  useEffect(() => {
    selectedCommitShaRef.current = selectedCommitSha;
  }, [selectedCommitSha]);

  useEffect(() => {
    selectedCommitFilePathRef.current = selectedCommitFilePath;
  }, [selectedCommitFilePath]);

  useEffect(() => {
    expandedCommitShaRef.current = expandedCommitSha;
  }, [expandedCommitSha]);

  const clearDiffs = useCallback(() => {
    diffRequestIdRef.current += 1;
    diffInFlightRequestIdRef.current = 0;
    branchDiffSignatureRef.current = "";
    worktreeDiffSignatureRef.current = "";
    setBranchDiff(null);
    setWorktreeDiff(null);
    setBranchError("");
    setDiffLoading(false);
  }, []);

  const loadDiffForPath = useCallback(
    async (path: string, options: GitRefreshOptions = {}) => {
      const cleanPath = path.trim();
      if (options.silent && diffInFlightRequestIdRef.current !== 0) {
        return;
      }
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      diffInFlightRequestIdRef.current = requestId;
      if (!options.silent) {
        setBranchError("");
        setError("");
      }
      if (!gitClient || !cwd.trim() || !cleanPath) {
        clearDiffs();
        return;
      }
      if (!options.silent) {
        setDiffLoading(true);
      }
      try {
        const [branchResult, worktreeResult] = await Promise.allSettled([
          gitClient.diff(cwd, "branch", cleanPath),
          gitClient.diff(cwd, "working_tree", cleanPath),
        ]);
        if (diffRequestIdRef.current !== requestId) return;
        if (branchResult.status === "fulfilled") {
          const signature = gitDiffSignature(branchResult.value);
          if (!options.silent || branchDiffSignatureRef.current !== signature) {
            setBranchDiff(branchResult.value);
          }
          branchDiffSignatureRef.current = signature;
          setBranchError("");
        } else {
          branchDiffSignatureRef.current = "";
          setBranchDiff(null);
          setBranchError(branchResult.reason instanceof Error ? branchResult.reason.message : String(branchResult.reason));
        }
        if (worktreeResult.status === "fulfilled") {
          const signature = gitDiffSignature(worktreeResult.value);
          if (!options.silent || worktreeDiffSignatureRef.current !== signature) {
            setWorktreeDiff(worktreeResult.value);
          }
          worktreeDiffSignatureRef.current = signature;
          setError("");
        } else {
          worktreeDiffSignatureRef.current = "";
          setWorktreeDiff(null);
          setError(worktreeResult.reason instanceof Error ? worktreeResult.reason.message : String(worktreeResult.reason));
        }
      } catch (err) {
        if (diffRequestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (diffRequestIdRef.current === requestId) {
          diffInFlightRequestIdRef.current = 0;
          if (!options.silent) {
            setDiffLoading(false);
          }
        }
      }
    },
    [clearDiffs, cwd, gitClient],
  );

  const refresh = useCallback(async (options: GitRefreshOptions = {}) => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    const silent = options.silent === true;
    const force = options.force !== false;
    if (!gitClient || !cwd.trim()) {
      statusSignatureRef.current = "";
      setState(emptyGitRepositoryState(cwd));
      setSelectedPath("");
      clearDiffs();
      refreshInFlightRef.current = false;
      return;
    }
    if (!silent) {
      setLoading(true);
      setError("");
      setBranchError("");
    }
    try {
      const nextState = await gitClient.status(cwd);
      const previousSignature = statusSignatureRef.current;
      const nextSignature = gitRepositoryStateSignature(nextState);
      const stateChanged = previousSignature !== nextSignature;
      statusSignatureRef.current = nextSignature;
      if (options.notifyChanged && previousSignature && stateChanged) {
        suppressNextGitChangedRef.current = true;
        dispatchGitChanged(cwd);
      }
      if (!force && !stateChanged) {
        const currentPath = selectedPathRef.current;
        if (currentPath && reviewModeRef.current === "changes") {
          void loadDiffForPath(currentPath, { silent: true, force: false });
        }
        return;
      }
      setState(nextState);
      if (nextState.status !== "ready") {
        selectedPathRef.current = "";
        setSelectedPath("");
        clearDiffs();
        return;
      }
      const currentPath = selectedPathRef.current;
      const nextPath = nextState.entries.some((entry) => entry.path === currentPath)
        ? currentPath
        : nextState.entries[0]?.path ?? "";
      selectedPathRef.current = nextPath;
      setSelectedPath(nextPath);
      if (nextPath) {
        void loadDiffForPath(nextPath, { silent: silent && nextPath === currentPath });
      } else {
        clearDiffs();
      }
    } catch (err) {
      if (!silent || force) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      refreshInFlightRef.current = false;
      if (!silent) {
        setLoading(false);
      }
    }
  }, [clearDiffs, cwd, gitClient, loadDiffForPath]);

  const loadCommitDiff = useCallback(
    async (commitSha: string, path: string) => {
      const cleanCommit = commitSha.trim();
      const cleanPath = path.trim();
      const requestId = commitDiffRequestIdRef.current + 1;
      commitDiffRequestIdRef.current = requestId;
      setHistoryError("");
      setCommitDiff(null);
      if (!gitClient || !cwd.trim() || !cleanCommit || !cleanPath) {
        setCommitDiffLoading(false);
        return;
      }
      setCommitDiffLoading(true);
      try {
        const diff = await gitClient.commitDiff(cwd, cleanCommit, cleanPath);
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiff(diff);
        }
      } catch (err) {
        if (commitDiffRequestIdRef.current === requestId) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiffLoading(false);
        }
      }
    },
    [cwd, gitClient],
  );

  const loadHistory = useCallback(async (options: GitRefreshOptions = {}) => {
    if (historyInFlightRef.current) {
      return;
    }
    historyInFlightRef.current = true;
    const silent = options.silent === true;
    const force = options.force !== false;
    if (!gitClient || !cwd.trim()) {
      historySignatureRef.current = "";
      setHistoryCommits([]);
      selectedCommitShaRef.current = "";
      selectedCommitFilePathRef.current = "";
      expandedCommitShaRef.current = "";
      setSelectedCommitSha("");
      setSelectedCommitFilePath("");
      setExpandedCommitSha("");
      setCommitDiff(null);
      setHistoryError("");
      historyInFlightRef.current = false;
      return;
    }
    if (!silent) {
      setHistoryLoading(true);
      setHistoryError("");
    }
    try {
      const response = await gitClient.log(cwd, GIT_HISTORY_LIMIT);
      const nextSignature = gitHistorySignature(response.state, response.commits);
      const historyChanged = historySignatureRef.current !== nextSignature;
      const previousStatusSignature = statusSignatureRef.current;
      const nextStatusSignature = gitRepositoryStateSignature(response.state);
      const statusChanged = previousStatusSignature !== nextStatusSignature;
      historySignatureRef.current = nextSignature;
      statusSignatureRef.current = nextStatusSignature;
      if (options.notifyChanged && previousStatusSignature && statusChanged) {
        suppressNextGitChangedRef.current = true;
        dispatchGitChanged(cwd);
      }
      if (!force && !historyChanged) {
        return;
      }
      setState(response.state);
      setHistoryCommits(response.commits);
      if (response.state.status !== "ready" || response.commits.length === 0) {
        selectedCommitShaRef.current = "";
        selectedCommitFilePathRef.current = "";
        expandedCommitShaRef.current = "";
        setSelectedCommitSha("");
        setSelectedCommitFilePath("");
        setExpandedCommitSha("");
        setCommitDiff(null);
        return;
      }
      const currentCommit = response.commits.find(
        (commit) => commit.sha === selectedCommitShaRef.current,
      );
      const nextCommit = currentCommit ?? response.commits[0];
      const currentFile =
        currentCommit?.files.find((file) => file.path === selectedCommitFilePathRef.current) ??
        null;
      const nextExpandedCommitSha = response.commits.some(
        (commit) => commit.sha === expandedCommitShaRef.current,
      )
        ? expandedCommitShaRef.current
        : "";
      selectedCommitShaRef.current = nextCommit.sha;
      selectedCommitFilePathRef.current = currentFile?.path ?? "";
      expandedCommitShaRef.current = nextExpandedCommitSha;
      setSelectedCommitSha(nextCommit.sha);
      setSelectedCommitFilePath(currentFile?.path ?? "");
      setExpandedCommitSha(nextExpandedCommitSha);
      if (currentCommit && currentFile) {
        void loadCommitDiff(currentCommit.sha, currentFile.path);
      } else {
        setCommitDiff(null);
      }
    } catch (err) {
      if (!silent || force) {
        setHistoryCommits([]);
        selectedCommitShaRef.current = "";
        selectedCommitFilePathRef.current = "";
        expandedCommitShaRef.current = "";
        setSelectedCommitSha("");
        setSelectedCommitFilePath("");
        setExpandedCommitSha("");
        setCommitDiff(null);
        setHistoryError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      historyInFlightRef.current = false;
      if (!silent) {
        setHistoryLoading(false);
      }
    }
  }, [cwd, gitClient, loadCommitDiff]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (reviewMode === "history") {
      void loadHistory();
    }
  }, [loadHistory, reviewMode]);

  useEffect(() => {
    if (!gitClient || !cwd.trim()) {
      return;
    }
    let stopped = false;
    const refreshVisiblePanel = () => {
      if (stopped || document.hidden || !panelRef.current?.getClientRects().length) {
        return;
      }
      if (reviewModeRef.current === "history") {
        void loadHistory({ silent: true, force: false, notifyChanged: true });
      } else {
        void refresh({ silent: true, force: false, notifyChanged: true });
      }
    };
    const interval = window.setInterval(refreshVisiblePanel, GIT_REVIEW_POLL_INTERVAL_MS);
    const handleFocus = () => refreshVisiblePanel();
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshVisiblePanel();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cwd, gitClient, loadHistory, refresh]);

  useEffect(() => {
    const handleGitChanged = () => {
      if (suppressNextGitChangedRef.current) {
        suppressNextGitChangedRef.current = false;
        return;
      }
      if (reviewModeRef.current === "history") {
        void loadHistory();
      } else {
        void refresh();
      }
    };
    window.addEventListener("liveagent:git-changed", handleGitChanged);
    return () => window.removeEventListener("liveagent:git-changed", handleGitChanged);
  }, [loadHistory, refresh]);

  const runOperation = useCallback(
    async (name: string, task: () => Promise<unknown>) => {
      if (!gitClient || !cwd.trim() || !canWrite) return;
      setBusy(name);
      setError("");
      try {
        const result = await task();
        assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
        await refresh();
        if (reviewModeRef.current === "history") {
          await loadHistory();
        }
        suppressNextGitChangedRef.current = true;
        dispatchGitChanged(cwd);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy("");
      }
    },
    [canWrite, cwd, gitClient, loadHistory, refresh, t],
  );

  const entries = state.entries;
  const [visibleEntryCount, setVisibleEntryCount] = useState(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  useEffect(() => {
    setVisibleEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  }, [state.repoRoot, state.head, entries.length]);
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleEntryCount),
    [entries, visibleEntryCount],
  );
  const hiddenEntryCount = Math.max(0, entries.length - visibleEntries.length);
  const writeDisabled = !canWrite || Boolean(disabledMessage) || state.status !== "ready";
  const hasStageableChanges = state.dirtyCounts.unstaged > 0 || state.dirtyCounts.untracked > 0;
  const hasStagedChanges = state.dirtyCounts.staged > 0;
  const hasDiscardableChanges = entries.length > 0;
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );
  const contextEntry = useMemo(
    () => entries.find((entry) => entry.path === changeContextMenu?.path) ?? null,
    [changeContextMenu?.path, entries],
  );
  const contextEntryCanStage = contextEntry ? canStageEntry(contextEntry) : false;
  const selectedCommit = useMemo(
    () => historyCommits.find((commit) => commit.sha === selectedCommitSha) ?? null,
    [historyCommits, selectedCommitSha],
  );
  const selectedCommitFile = useMemo(
    () => selectedCommit?.files.find((file) => file.path === selectedCommitFilePath) ?? null,
    [selectedCommit, selectedCommitFilePath],
  );
  const gitGraph = useMemo(() => computeGitGraph(historyCommits), [historyCommits]);
  const historyRows = useMemo<GitHistoryRow[]>(() => {
    const rows: GitHistoryRow[] = [];
    historyCommits.forEach((commit, commitIndex) => {
      rows.push({ type: "commit", commit, commitIndex });
      if (commit.sha === expandedCommitSha) {
        commit.files.forEach((file) => rows.push({ type: "file", commit, commitIndex, file }));
      }
    });
    return rows;
  }, [expandedCommitSha, historyCommits]);
  const historyVirtualizer = useVirtualizer({
    count: historyRows.length,
    getScrollElement: () => historyListRef.current,
    estimateSize: (index) => (historyRows[index]?.type === "file" ? 26 : 28),
    overscan: 8,
    getItemKey: (index) => {
      const row = historyRows[index];
      if (!row) return index;
      if (row.type === "commit") return `commit:${row.commit.sha}`;
      return `file:${row.commit.sha}:${row.file.status}:${row.file.oldPath ?? ""}:${row.file.path}`;
    },
  });

  useEffect(() => {
    if (!changeContextMenu) return;
    const closeMenu = () => setChangeContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changeContextMenu]);

  useEffect(() => {
    if (!changesMenu) return;
    const closeMenu = () => setChangesMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changesMenu]);

  const selectEntry = useCallback(
    (entry: GitStatusEntry) => {
      selectedPathRef.current = entry.path;
      setSelectedPath(entry.path);
      void loadDiffForPath(entry.path);
    },
    [loadDiffForPath],
  );

  const selectCommit = useCallback(
    (commit: GitCommitSummary) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = "";
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath("");
      setCommitDiff(null);
      setHistoryError("");
      setExpandedCommitSha((current) => {
        const next = current === commit.sha ? "" : commit.sha;
        expandedCommitShaRef.current = next;
        return next;
      });
    },
    [],
  );

  const selectCommitFile = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = file.path;
      expandedCommitShaRef.current = commit.sha;
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath(file.path);
      setExpandedCommitSha(commit.sha);
      void loadCommitDiff(commit.sha, file.path);
    },
    [loadCommitDiff],
  );

  const openChangeContextMenu = useCallback(
    (event: ReactMouseEvent, entry: GitStatusEntry) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      const panelRect = panelRef.current?.getBoundingClientRect();
      const left = panelRect ? event.clientX - panelRect.left : event.clientX;
      const top = panelRect ? event.clientY - panelRect.top : event.clientY;
      const maxLeft = Math.max(8, (panelRect?.width ?? window.innerWidth) - CHANGE_CONTEXT_MENU_WIDTH - 8);
      const maxTop = Math.max(8, (panelRect?.height ?? window.innerHeight) - CHANGE_CONTEXT_MENU_HEIGHT - 8);
      setChangeContextMenu({
        x: Math.max(8, Math.min(left, maxLeft)),
        y: Math.max(8, Math.min(top, maxTop)),
        path: entry.path,
      });
    },
    [],
  );

  const openChangesMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setChangeContextMenu(null);
    const panelRect = panelRef.current?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const left = panelRect ? buttonRect.right - panelRect.left - CHANGES_MENU_WIDTH : buttonRect.right - CHANGES_MENU_WIDTH;
    const top = panelRect ? buttonRect.bottom - panelRect.top + 4 : buttonRect.bottom + 4;
    const maxLeft = Math.max(8, (panelRect?.width ?? window.innerWidth) - CHANGES_MENU_WIDTH - 8);
    const maxTop = Math.max(8, (panelRect?.height ?? window.innerHeight) - CHANGES_MENU_HEIGHT - 8);
    setChangesMenu({
      x: Math.max(8, Math.min(left, maxLeft)),
      y: Math.max(8, Math.min(top, maxTop)),
    });
  }, []);

  const viewEntryChanges = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      setActiveDiffView("workingTree");
      selectEntry(entry);
    },
    [selectEntry],
  );

  const stageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("stage", () => gitClient!.stage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const discardEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      const message = t("projectTools.gitReview.discardConfirm").replace("{path}", entry.path);
      if (!window.confirm(message)) return;
      void runOperation("discard", () =>
        gitClient!.discard(cwd, entry.path, entry.oldPath ?? undefined),
      );
    },
    [cwd, gitClient, runOperation, t],
  );

  const addEntryToGitignore = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("add_to_gitignore", () => gitClient!.addToGitignore(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const stageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("stage_all", () => gitClient!.stageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const unstageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("unstage_all", () => gitClient!.unstageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const discardAllChanges = useCallback(() => {
    setChangesMenu(null);
    const message = t("projectTools.gitReview.discardAllConfirm");
    if (!window.confirm(message)) return;
    void runOperation("discard_all", () => gitClient!.discardAll(cwd));
  }, [cwd, gitClient, runOperation, t]);

  const revealEntryInFileTree = useCallback(
    (entry: GitStatusEntry) => {
      if (!onRevealInFileTree) return;
      setChangeContextMenu(null);
      onRevealInFileTree(revealTargetForEntry(entry));
    },
    [onRevealInFileTree],
  );

  const visibleError = reviewMode === "history" ? (historyCommits.length === 0 ? historyError : "") : error;

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {state.head || t("projectTools.gitReviewTitle")}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {state.repoRoot || disabledMessage || t("projectTools.gitReview.noRepository")}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || historyLoading}
            title={t("projectTools.gitReview.refresh")}
            aria-label={t("projectTools.gitReview.refresh")}
            onClick={() => {
              if (reviewMode === "history") {
                void loadHistory({ notifyChanged: true });
              } else {
                void refresh({ notifyChanged: true });
              }
            }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (loading || historyLoading) && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "fetch"}
            title={t("projectTools.gitReview.fetch")}
            onClick={() => void runOperation("fetch", () => gitClient!.fetch(cwd))}
          >
            {t("projectTools.gitReview.fetch")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "pull"}
            title={t("projectTools.gitReview.pull")}
            onClick={() => void runOperation("pull", () => gitClient!.pull(cwd))}
          >
            {t("projectTools.gitReview.pull")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "push"}
            title={t("projectTools.gitReview.push")}
            aria-label={t("projectTools.gitReview.push")}
            onClick={() => void runOperation("push", () => gitClient!.push(cwd))}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
        </div>
        {state.status === "ready" ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span>
              {t("projectTools.gitReview.statusBase").replace(
                "{value}",
                branchDiff?.baseRef || state.upstream || t("projectTools.gitReview.unresolved"),
              )}
            </span>
            <span>{t("projectTools.gitReview.statusAhead").replace("{count}", String(state.ahead))}</span>
            <span>{t("projectTools.gitReview.statusBehind").replace("{count}", String(state.behind))}</span>
            <span>
              {t("projectTools.gitReview.statusStaged").replace("{count}", String(state.dirtyCounts.staged))}
            </span>
            <span>
              {t("projectTools.gitReview.statusUnstaged").replace("{count}", String(state.dirtyCounts.unstaged))}
            </span>
            <span>
              {t("projectTools.gitReview.statusUntracked").replace("{count}", String(state.dirtyCounts.untracked))}
            </span>
          </div>
        ) : null}
        <div className="mt-3 inline-flex rounded-md border border-border bg-muted/25 p-0.5 text-xs">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
              reviewMode === "changes" && "bg-background text-foreground shadow-sm",
            )}
            onClick={() => {
              setReviewMode("changes");
              setChangeContextMenu(null);
              setChangesMenu(null);
            }}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("projectTools.gitReview.localChangesView")}
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
              reviewMode === "history" && "bg-background text-foreground shadow-sm",
            )}
            onClick={() => {
              setReviewMode("history");
              setChangeContextMenu(null);
              setChangesMenu(null);
            }}
          >
            <History className="h-3.5 w-3.5" />
            {t("projectTools.gitReview.commitHistoryView")}
          </button>
        </div>
        {!canWrite && disabledMessage ? (
          <div className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {disabledMessage}
          </div>
        ) : null}
        {visibleError ? <div className="mt-2 text-xs text-destructive">{visibleError}</div> : null}
      </div>

      {reviewMode === "changes" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(8rem,14rem)_minmax(0,1fr)] md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border md:border-b-0 md:border-r">
          <div className="relative z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-1.5">
            <div className="min-w-0 truncate text-xs font-semibold">
              {t("projectTools.gitReview.changesTitle")}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 w-6 shrink-0 px-0"
              title={t("projectTools.gitReview.changesActions")}
              aria-label={t("projectTools.gitReview.changesActions")}
              onClick={openChangesMenu}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                {t("projectTools.gitReview.noLocalChanges")}
              </div>
            ) : (
              <>
                {visibleEntries.map((entry) => {
                  const selected = entry.path === selectedPath;
                  const contextMenuOpen = entry.path === changeContextMenu?.path;
                  const TypeIcon = getFileTypeIcon(entry.path, "file");
                  const fileName = basename(entry.path);
                  const filePath = parentPath(entry.path);
                  return (
                    <div
                      key={`${entry.kind}:${entry.path}`}
                      className={cn(
                        "select-none border-b border-l-2 border-border/60 border-l-transparent px-3 py-2 transition-colors hover:bg-muted/40",
                        selected && "border-l-emerald-500 bg-emerald-500/10",
                        contextMenuOpen && "border-l-primary bg-primary/10 ring-1 ring-inset ring-primary/35",
                      )}
                      onMouseDown={(event) => {
                        if (event.button === 2) {
                          window.getSelection()?.removeAllRanges();
                        }
                      }}
                      onContextMenu={(event) => openChangeContextMenu(event, entry)}
                    >
                      <button
                        type="button"
                        className="flex w-full select-none items-start gap-2 rounded-sm bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => selectEntry(entry)}
                        title={entry.path}
                      >
                        <TypeIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 select-none">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {fileName}
                          </span>
                          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                            {filePath}
                          </span>
                        </span>
                        <span className={cn("mt-0.5 shrink-0 text-[10px] font-semibold", statusTone(entry))}>
                          {statusLabel(entry)}
                        </span>
                      </button>
                    </div>
                  );
                })}
                {hiddenEntryCount > 0 ? (
                  <div className="border-b border-border/60 px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full text-xs"
                      onClick={() =>
                        setVisibleEntryCount((current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE)
                      }
                    >
                      {t("projectTools.gitReview.showMoreChanges").replace(
                        "{count}",
                        String(Math.min(hiddenEntryCount, CHANGE_ENTRY_RENDER_BATCH_SIZE)),
                      )}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
        <main className="flex h-full min-h-0 flex-col overflow-hidden p-3">
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
            <Input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t("projectTools.gitReview.commitMessagePlaceholder")}
              disabled={writeDisabled}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              disabled={writeDisabled || !commitMessage.trim() || busy === "commit"}
              onClick={() => {
                void runOperation("commit", () => gitClient!.commit(cwd, commitMessage)).then(
                  (ok) => {
                    if (ok) setCommitMessage("");
                  },
                );
              }}
            >
              {busy === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("projectTools.gitReview.commit")}
            </Button>
          </div>
          {selectedEntry ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t("projectTools.gitReview.selected")}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={selectedEntry.path}>
                  {selectedEntry.path}
                </span>
              </div>
              <DiffReviewCard
                activeView={activeDiffView}
                branchDiff={branchDiff}
                branchError={branchError}
                diffLoading={diffLoading}
                onActiveViewChange={setActiveDiffView}
                worktreeDiff={worktreeDiff}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
              {t("projectTools.gitReview.selectFileToViewDiff")}
            </div>
          )}
        </main>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(10rem,18rem)_minmax(0,1fr)] md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1">
          <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border md:border-b-0 md:border-r">
            <div className="relative z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold">
                <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t("projectTools.gitReview.commitHistoryTitle")}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 w-6 shrink-0 px-0"
                disabled={historyLoading}
                title={t("projectTools.gitReview.refresh")}
                aria-label={t("projectTools.gitReview.refresh")}
                onClick={() => void loadHistory({ notifyChanged: true })}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", historyLoading && "animate-spin")} />
              </Button>
            </div>
            <div ref={historyListRef} className="min-h-0 flex-1 overflow-auto">
              {historyLoading && historyCommits.length === 0 ? (
                <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("projectTools.gitReview.commitHistoryTitle")}</span>
                </div>
              ) : historyCommits.length === 0 ? (
                <div className="px-3 py-6 text-xs text-muted-foreground">
                  {historyError || t("projectTools.gitReview.noCommitHistory")}
                </div>
              ) : (
                <div className="relative" style={{ height: `${historyVirtualizer.getTotalSize()}px` }}>
                  {historyVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = historyRows[virtualRow.index];
                    if (!row) return null;
                    if (row.type === "file") {
                      const TypeIcon = getFileTypeIcon(row.file.path, "file");
                      const fileSelected =
                        row.commit.sha === selectedCommitSha && row.file.path === selectedCommitFilePath;
                      const fileName = basename(row.file.path);
                      const filePath = row.file.oldPath
                        ? `${parentPath(row.file.oldPath)} -> ${parentPath(row.file.path)}`
                        : parentPath(row.file.path);
                      const graphRow = gitGraph.rows[row.commitIndex];
                      return (
                        <div
                          key={virtualRow.key}
                          ref={historyVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div className="flex min-w-0">
                            {graphRow ? (
                              <GitGraphContinuationCell
                                row={graphRow}
                                isLast={row.commitIndex === historyCommits.length - 1}
                              />
                            ) : null}
                            <button
                              type="button"
                              className={cn(
                                "mr-1 flex h-6 min-w-0 flex-1 select-none items-center gap-1.5 rounded px-1.5 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                fileSelected && "bg-accent text-accent-foreground",
                              )}
                              title={row.file.oldPath ? `${row.file.oldPath} -> ${row.file.path}` : row.file.path}
                              onClick={() => selectCommitFile(row.commit, row.file)}
                            >
                              <TypeIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-medium">{fileName}</span>
                                <span className="ml-1 text-[10px] text-muted-foreground">
                                  {filePath}
                                </span>
                              </span>
                              <span className={cn("shrink-0 text-[10px] font-semibold", commitFileStatusTone(row.file))}>
                                {commitFileStatusLabel(row.file)}
                              </span>
                            </button>
                          </div>
                        </div>
                      );
                    }
                    const commit = row.commit;
                    const commitSelected = commit.sha === selectedCommitSha;
                    const commitExpanded = commit.sha === expandedCommitSha;
                    const graphRow = gitGraph.rows[row.commitIndex];
                    return (
                      <div
                        key={virtualRow.key}
                        ref={historyVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 w-full"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <div className="flex min-w-0">
                          {graphRow ? (
                            <GitGraphSvgCell
                              row={graphRow}
                              isFirst={row.commitIndex === 0}
                              isLast={row.commitIndex === historyCommits.length - 1}
                            />
                          ) : null}
                          <button
                            type="button"
                            className={cn(
                              "flex h-7 min-w-0 flex-1 items-center rounded px-1.5 pr-1 text-left text-xs transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              commitSelected && "bg-accent/80 text-accent-foreground",
                            )}
                            title={commit.subject || commit.shortSha}
                            aria-expanded={commitExpanded}
                            onClick={() => selectCommit(commit)}
                          >
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                              {commit.subject || commit.shortSha}
                            </span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
          <main className="flex h-full min-h-0 flex-col overflow-hidden p-3">
            {selectedCommit ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                <div className="flex shrink-0 items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                  <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground" title={selectedCommit.subject}>
                      {selectedCommit.subject || selectedCommit.shortSha}
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">{selectedCommit.shortSha}</span>
                      <span>{selectedCommit.authorName}</span>
                      <span>{formatCommitDate(selectedCommit.authorDate)}</span>
                    </div>
                  </div>
                </div>
                {selectedCommitFile ? (
                  <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
                    <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold">
                          {t("projectTools.gitReview.commitDiff")}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground" title={selectedCommitFile.path}>
                          {basename(selectedCommitFile.path)} - {selectedCommit.shortSha}
                        </div>
                      </div>
                      {commitDiffLoading ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </div>
                    {commitDiffLoading && !commitDiff && !historyError ? (
                      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    ) : (
                      <DiffContent
                        title={t("projectTools.gitReview.commitDiff")}
                        diff={commitDiff}
                        error={historyError}
                      />
                    )}
                  </section>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
                    {t("projectTools.gitReview.selectCommitFileToViewDiff")}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
                {historyError || t("projectTools.gitReview.selectCommitToViewFiles")}
              </div>
            )}
          </main>
        </div>
      )}
      {reviewMode === "changes" && changesMenu ? (
        <div
          role="menu"
          className="absolute z-[75] min-w-56 select-none overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-xl"
          style={{ left: changesMenu.x, top: changesMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasStageableChanges}
            onClick={stageAllChanges}
          >
            <FilePenLine className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.stageAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasStagedChanges}
            onClick={unstageAllChanges}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.unstageAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasDiscardableChanges}
            onClick={discardAllChanges}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={loading}
            onClick={() => {
              setChangesMenu(null);
              void refresh({ notifyChanged: true });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.refreshChanges")}</span>
          </button>
        </div>
      ) : null}
      {reviewMode === "changes" && changeContextMenu && contextEntry ? (
        <div
          role="menu"
          className="absolute z-[80] min-w-56 select-none overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-xl"
          style={{ left: changeContextMenu.x, top: changeContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            onClick={() => viewEntryChanges(contextEntry)}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.viewChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !contextEntryCanStage}
            onClick={() => stageEntry(contextEntry)}
          >
            <FilePenLine className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.stageChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => discardEntry(contextEntry)}
          >
            <BrushCleaning className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => addEntryToGitignore(contextEntry)}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.addToGitignore")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={!onRevealInFileTree}
            onClick={() => revealEntryInFileTree(contextEntry)}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.revealInFileTree")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
