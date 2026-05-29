use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::NamedTempFile;
use wait_timeout::ChildExt;

const GIT_DIFF_MAX_BYTES: usize = 512 * 1024;
const GIT_UNTRACKED_FILE_MAX_BYTES: u64 = 128 * 1024;
const GIT_COMMAND_TIMEOUT_SECS: u64 = 60;
const GIT_LOG_DEFAULT_LIMIT: usize = 80;
const GIT_LOG_MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitDirtyCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: String,
    pub staged: bool,
    pub conflicted: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub repo_root: String,
    pub workdir: String,
    pub head: String,
    pub upstream: String,
    pub ahead: i32,
    pub behind: i32,
    pub dirty_counts: GitDirtyCounts,
    pub entries: Vec<GitStatusEntry>,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub full_name: String,
    pub kind: String,
    pub current: bool,
    pub upstream: String,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesResponse {
    pub state: GitRepositoryState,
    pub branches: Vec<GitBranch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResponse {
    pub base_ref: String,
    pub head_ref: String,
    pub mode: String,
    pub files: Vec<String>,
    pub patch: String,
    pub stat: String,
    pub truncated: bool,
    pub binary_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub files: Vec<GitCommitFile>,
    pub file_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResponse {
    pub state: GitRepositoryState,
    pub commits: Vec<GitCommitSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResponse {
    pub ok: bool,
    pub state: GitRepositoryState,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GitGatewayArgs {
    branch: Option<String>,
    kind: Option<String>,
    path: Option<String>,
    old_path: Option<String>,
    message: Option<String>,
    mode: Option<String>,
    commit: Option<String>,
    limit: Option<usize>,
    user_name: Option<String>,
    user_email: Option<String>,
}

struct GitOutput {
    stdout: String,
    stderr: String,
}

fn trim_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn read_temp_file(file: &mut NamedTempFile, label: &str) -> Result<Vec<u8>, String> {
    let handle = file.as_file_mut();
    handle
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("读取 git {label} 失败：{error}"))?;
    let mut bytes = Vec::new();
    handle
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 git {label} 失败：{error}"))?;
    Ok(bytes)
}

fn git_output(workdir: &str, args: &[&str]) -> Result<Output, String> {
    let mut stdout_file =
        NamedTempFile::new().map_err(|error| format!("创建 git stdout 缓存失败：{error}"))?;
    let mut stderr_file =
        NamedTempFile::new().map_err(|error| format!("创建 git stderr 缓存失败：{error}"))?;
    let stdout_target = stdout_file
        .reopen()
        .map_err(|error| format!("打开 git stdout 缓存失败：{error}"))?;
    let stderr_target = stderr_file
        .reopen()
        .map_err(|error| format!("打开 git stderr 缓存失败：{error}"))?;
    let mut child = Command::new("git")
        .args(args)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_target))
        .stderr(Stdio::from(stderr_target))
        .spawn()
        .map_err(|error| format!("git 执行失败：{error}"))?;
    let timeout = Duration::from_secs(GIT_COMMAND_TIMEOUT_SECS);
    let Some(status) = child
        .wait_timeout(timeout)
        .map_err(|error| format!("等待 git 命令失败：{error}"))?
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "git 命令超时（{GIT_COMMAND_TIMEOUT_SECS} 秒）：git {}",
            args.join(" ")
        ));
    };
    Ok(Output {
        status,
        stdout: read_temp_file(&mut stdout_file, "stdout")?,
        stderr: read_temp_file(&mut stderr_file, "stderr")?,
    })
}

fn git_success(workdir: &str, args: &[&str]) -> Result<GitOutput, String> {
    let output = git_output(workdir, args)?;
    let stdout = trim_output(&output.stdout);
    let stderr = trim_output(&output.stderr);
    if output.status.success() {
        Ok(GitOutput { stdout, stderr })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn discover_repo(workdir: &str) -> Result<Option<String>, String> {
    let trimmed = workdir.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let output = git_output(
        trimmed,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--is-inside-work-tree",
        ],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let root = lines.next().unwrap_or("").trim().to_string();
    let _git_dir = lines.next().unwrap_or("").trim();
    let inside = lines.next().unwrap_or("").trim();
    if root.is_empty() || inside != "true" {
        return Ok(None);
    }
    Ok(Some(root))
}

fn not_repo_state(workdir: &str) -> GitRepositoryState {
    GitRepositoryState {
        repo_root: String::new(),
        workdir: workdir.trim().to_string(),
        head: String::new(),
        upstream: String::new(),
        ahead: 0,
        behind: 0,
        dirty_counts: GitDirtyCounts::default(),
        entries: Vec::new(),
        status: "not_repo".to_string(),
        error: None,
    }
}

fn parse_branch_ab(value: &str) -> (i32, i32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in value.split_whitespace() {
        if let Some(raw) = part.strip_prefix('+') {
            ahead = raw.parse::<i32>().unwrap_or(0);
        } else if let Some(raw) = part.strip_prefix('-') {
            behind = raw.parse::<i32>().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn status_entry(
    path: String,
    old_path: Option<String>,
    index: char,
    worktree: char,
    kind: &str,
) -> GitStatusEntry {
    let conflicted = kind == "conflict" || index == 'U' || worktree == 'U';
    let untracked = kind == "untracked";
    let staged = !untracked && !conflicted && index != '.';
    GitStatusEntry {
        path,
        old_path,
        index_status: index.to_string(),
        worktree_status: worktree.to_string(),
        kind: kind.to_string(),
        staged,
        conflicted,
        untracked,
    }
}

fn parse_status_porcelain_v2(raw: &[u8]) -> (String, String, i32, i32, Vec<GitStatusEntry>) {
    let mut head = String::new();
    let mut upstream = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    let records: Vec<String> = raw
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index].trim_end_matches('\n');
        if let Some(value) = record.strip_prefix("# branch.head ") {
            head = value.trim().to_string();
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = value.trim().to_string();
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            (ahead, behind) = parse_branch_ab(value);
        } else if let Some(rest) = record.strip_prefix("1 ") {
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if fields.len() >= 8 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('.');
                let wt = chars.next().unwrap_or('.');
                entries.push(status_entry(
                    fields[7].to_string(),
                    None,
                    ix,
                    wt,
                    "modified",
                ));
            }
        } else if let Some(rest) = record.strip_prefix("2 ") {
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            if fields.len() >= 9 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('.');
                let wt = chars.next().unwrap_or('.');
                let old_path = records.get(index + 1).cloned();
                if old_path.is_some() {
                    index += 1;
                }
                entries.push(status_entry(
                    fields[8].to_string(),
                    old_path,
                    ix,
                    wt,
                    "renamed",
                ));
            }
        } else if let Some(rest) = record.strip_prefix("u ") {
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            if fields.len() >= 10 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('U');
                let wt = chars.next().unwrap_or('U');
                entries.push(status_entry(
                    fields[9].to_string(),
                    None,
                    ix,
                    wt,
                    "conflict",
                ));
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            entries.push(status_entry(path.to_string(), None, '?', '?', "untracked"));
        }
        index += 1;
    }
    (head, upstream, ahead, behind, entries)
}

fn dirty_counts(entries: &[GitStatusEntry]) -> GitDirtyCounts {
    let mut counts = GitDirtyCounts::default();
    for entry in entries {
        if entry.conflicted {
            counts.conflicted += 1;
        } else if entry.untracked {
            counts.untracked += 1;
        } else {
            if entry.index_status != "." {
                counts.staged += 1;
            }
            if entry.worktree_status != "." {
                counts.unstaged += 1;
            }
        }
    }
    counts
}

pub(crate) fn git_status_sync(workdir: String) -> Result<GitRepositoryState, String> {
    let workdir = workdir.trim().to_string();
    let Some(repo_root) = discover_repo(&workdir)? else {
        return Ok(not_repo_state(&workdir));
    };
    let output = git_output(
        &repo_root,
        &["status", "--porcelain=v2", "--branch", "--show-stash", "-z"],
    )?;
    if !output.status.success() {
        return Ok(GitRepositoryState {
            repo_root,
            workdir,
            head: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            dirty_counts: GitDirtyCounts::default(),
            entries: Vec::new(),
            status: "error".to_string(),
            error: Some(trim_output(&output.stderr)),
        });
    }
    let (head, upstream, ahead, behind, entries) = parse_status_porcelain_v2(&output.stdout);
    Ok(GitRepositoryState {
        repo_root,
        workdir,
        head,
        upstream,
        ahead,
        behind,
        dirty_counts: dirty_counts(&entries),
        entries,
        status: "ready".to_string(),
        error: None,
    })
}

fn branch_name_from_remote(remote_short: &str) -> String {
    remote_short
        .split_once('/')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| remote_short.to_string())
}

pub(crate) fn git_branches_sync(workdir: String) -> Result<GitBranchesResponse, String> {
    let state = git_status_sync(workdir)?;
    if state.status != "ready" {
        return Ok(GitBranchesResponse {
            state,
            branches: Vec::new(),
        });
    }
    let output = git_success(
        &state.repo_root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut branches = Vec::new();
    for line in output.stdout.lines() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 4 {
            continue;
        }
        let full_name = parts[0].trim();
        let short = parts[1].trim();
        if full_name.is_empty() || short.is_empty() || short.ends_with("/HEAD") {
            continue;
        }
        let kind = if full_name.starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };
        let name = if kind == "remote" {
            branch_name_from_remote(short)
        } else {
            short.to_string()
        };
        let current = parts[3].trim() == "*" || (kind == "local" && short == state.head);
        branches.push(GitBranch {
            name,
            full_name: short.to_string(),
            kind: kind.to_string(),
            current,
            upstream: parts[2].trim().to_string(),
            ahead: if current { state.ahead } else { 0 },
            behind: if current { state.behind } else { 0 },
        });
    }
    branches.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.full_name.cmp(&right.full_name))
    });
    Ok(GitBranchesResponse { state, branches })
}

fn ensure_ready_state(workdir: &str) -> Result<GitRepositoryState, String> {
    let state = git_status_sync(workdir.to_string())?;
    if state.status == "ready" {
        Ok(state)
    } else {
        Err(state
            .error
            .unwrap_or_else(|| "当前项目不是 Git 仓库。".to_string()))
    }
}

fn validate_repo_relative_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("Git 文件路径不能为空。".to_string());
    }
    let path = Path::new(&trimmed);
    if path.is_absolute() {
        return Err("Git 文件路径不能是绝对路径。".to_string());
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err("Git 文件路径不能包含 .. 或根路径。".to_string());
        }
    }
    Ok(trimmed)
}

fn validate_branch_name(repo_root: &str, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空。".to_string());
    }
    if branch.chars().any(char::is_whitespace) {
        return Err("分支名不能包含空白字符。".to_string());
    }
    git_success(repo_root, &["check-ref-format", "--branch", branch])?;
    Ok(branch.to_string())
}

fn validate_git_init_workdir(workdir: &str) -> Result<String, String> {
    let workdir = workdir.trim();
    if workdir.is_empty() {
        return Err("初始化目录不能为空。".to_string());
    }
    let metadata = fs::metadata(workdir).map_err(|error| format!("初始化目录不可访问：{error}"))?;
    if !metadata.is_dir() {
        return Err("初始化目录必须是文件夹。".to_string());
    }
    Ok(workdir.to_string())
}

fn validate_git_config_value(label: &str, value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().any(|ch| matches!(ch, '\0' | '\n' | '\r')) {
        return Err(format!("{label} 不能包含换行或空字符。"));
    }
    Ok(Some(value.to_string()))
}

fn append_output(target: &mut String, value: &str) {
    if value.trim().is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(value);
}

fn build_untracked_file_patch(repo_root: &str, path: &str) -> Result<Option<String>, String> {
    let clean_path = validate_repo_relative_path(path)?;
    let repo_root_path =
        fs::canonicalize(repo_root).map_err(|error| format!("Git 仓库路径不可访问：{error}"))?;
    let absolute_path = fs::canonicalize(Path::new(repo_root).join(&clean_path))
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if !absolute_path.starts_with(&repo_root_path) {
        return Err("Git 文件路径必须位于当前仓库内。".to_string());
    }
    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if !metadata.is_file() || metadata.len() > GIT_UNTRACKED_FILE_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&absolute_path)
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let added_line_count = if content.is_empty() {
        0
    } else {
        content.lines().count().max(1)
    };
    let mut patch = format!(
        "diff --git a/{clean_path} b/{clean_path}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/{clean_path}\n@@ -0,0 +1,{added_line_count} @@\n"
    );
    if content.is_empty() {
        return Ok(Some(patch));
    }
    for line in content.split_inclusive('\n') {
        let line = line.trim_end_matches('\n').trim_end_matches('\r');
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !content.ends_with('\n') {
        patch.push_str("\\ No newline at end of file\n");
    }
    Ok(Some(patch))
}

fn append_untracked_file_patches(
    repo_root: &str,
    entries: &[GitStatusEntry],
    path_filter: Option<&str>,
    patch: &mut String,
    binary_files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries.iter().filter(|entry| entry.untracked) {
        if path_filter.is_some_and(|path| path != entry.path) {
            continue;
        }
        match build_untracked_file_patch(repo_root, &entry.path)? {
            Some(untracked_patch) => {
                if !patch.trim().is_empty() {
                    patch.push('\n');
                }
                patch.push_str(&untracked_patch);
            }
            None => binary_files.push(entry.path.clone()),
        }
    }
    Ok(())
}

fn append_initial_worktree_file_patches(
    repo_root: &str,
    entries: &[GitStatusEntry],
    path_filter: Option<&str>,
    patch: &mut String,
    binary_files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries {
        if path_filter.is_some_and(|path| path != entry.path) {
            continue;
        }
        let clean_path = validate_repo_relative_path(&entry.path)?;
        if !Path::new(repo_root).join(&clean_path).exists() {
            continue;
        }
        match build_untracked_file_patch(repo_root, &clean_path)? {
            Some(initial_patch) => {
                if !patch.trim().is_empty() {
                    patch.push('\n');
                }
                patch.push_str(&initial_patch);
            }
            None => binary_files.push(clean_path),
        }
    }
    Ok(())
}

fn operation_response(
    workdir: &str,
    result: Result<GitOutput, String>,
    success_message: &str,
) -> Result<GitOperationResponse, String> {
    let state = git_status_sync(workdir.to_string())?;
    match result {
        Ok(output) => Ok(GitOperationResponse {
            ok: true,
            state,
            stdout: output.stdout,
            stderr: output.stderr,
            message: success_message.to_string(),
        }),
        Err(error) => Ok(GitOperationResponse {
            ok: false,
            state,
            stdout: String::new(),
            stderr: error.clone(),
            message: error,
        }),
    }
}

pub(crate) fn git_switch_branch_sync(
    workdir: String,
    branch: String,
    kind: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    let args = if kind.as_deref() == Some("remote") || branch.starts_with("origin/") {
        vec!["switch", "--track", branch.as_str()]
    } else {
        vec!["switch", branch.as_str()]
    };
    operation_response(
        &workdir,
        git_success(&state.repo_root, &args),
        "分支已切换。",
    )
}

pub(crate) fn git_create_branch_sync(
    workdir: String,
    branch: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["switch", "-c", branch.as_str()]),
        "分支已创建并检出。",
    )
}

pub(crate) fn git_init_sync(
    workdir: String,
    branch: String,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitOperationResponse, String> {
    let workdir = validate_git_init_workdir(&workdir)?;
    let existing_state = git_status_sync(workdir.clone())?;
    if existing_state.status == "ready" {
        return Err("当前目录已位于 Git 仓库内。".to_string());
    }

    let branch = {
        let branch = branch.trim();
        if branch.is_empty() {
            "main".to_string()
        } else {
            branch.to_string()
        }
    };
    if branch.chars().any(char::is_whitespace) {
        return Err("分支名不能包含空白字符。".to_string());
    }
    git_success(&workdir, &["check-ref-format", "--branch", branch.as_str()])?;

    let user_name = validate_git_config_value("Git user.name", user_name)?;
    let user_email = validate_git_config_value("Git user.email", user_email)?;
    let init_output = match git_success(&workdir, &["init", "-b", branch.as_str()]) {
        Ok(output) => output,
        Err(error) => {
            return operation_response(&workdir, Err(error), "Git 仓库已初始化。");
        }
    };

    let mut stdout = init_output.stdout;
    let mut stderr = init_output.stderr;
    if let Some(user_name) = user_name {
        match git_success(&workdir, &["config", "user.name", user_name.as_str()]) {
            Ok(output) => {
                append_output(&mut stdout, &output.stdout);
                append_output(&mut stderr, &output.stderr);
            }
            Err(error) => {
                let state = git_status_sync(workdir.clone())?;
                return Ok(GitOperationResponse {
                    ok: false,
                    state,
                    stdout,
                    stderr: error.clone(),
                    message: error,
                });
            }
        }
    }
    if let Some(user_email) = user_email {
        match git_success(&workdir, &["config", "user.email", user_email.as_str()]) {
            Ok(output) => {
                append_output(&mut stdout, &output.stdout);
                append_output(&mut stderr, &output.stderr);
            }
            Err(error) => {
                let state = git_status_sync(workdir.clone())?;
                return Ok(GitOperationResponse {
                    ok: false,
                    state,
                    stdout,
                    stderr: error.clone(),
                    message: error,
                });
            }
        }
    }

    Ok(GitOperationResponse {
        ok: true,
        state: git_status_sync(workdir)?,
        stdout,
        stderr,
        message: "Git 仓库已初始化。".to_string(),
    })
}

fn ref_exists(repo_root: &str, reference: &str) -> bool {
    git_output(repo_root, &["rev-parse", "--verify", "--quiet", reference])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn resolve_review_base(state: &GitRepositoryState) -> String {
    if !state.upstream.trim().is_empty() {
        return state.upstream.clone();
    }
    for candidate in [
        "origin/main",
        "origin/master",
        "origin/develop",
        "main",
        "master",
        "develop",
    ] {
        if ref_exists(&state.repo_root, candidate) {
            return candidate.to_string();
        }
    }
    String::new()
}

fn split_stat_and_patch(output: &str) -> (String, String) {
    let marker = "\ndiff --git ";
    if let Some(index) = output.find(marker) {
        let stat = output[..index].trim().to_string();
        let patch = output[index + 1..].to_string();
        (stat, patch)
    } else if output.starts_with("diff --git ") {
        (String::new(), output.to_string())
    } else {
        (output.trim().to_string(), String::new())
    }
}

fn truncate_patch(value: String) -> (String, bool) {
    if value.len() <= GIT_DIFF_MAX_BYTES {
        return (value, false);
    }
    let mut end = GIT_DIFF_MAX_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn commit_file_kind(status: &str) -> String {
    match status.chars().next().unwrap_or('M') {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type_changed",
        _ => "modified",
    }
    .to_string()
}

fn parse_name_status_line(line: &str) -> Option<GitCommitFile> {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split('\t');
    let raw_status = parts.next()?.trim();
    if raw_status.is_empty() {
        return None;
    }
    let status = raw_status
        .chars()
        .next()
        .unwrap_or('M')
        .to_ascii_uppercase()
        .to_string();
    if status == "R" || status == "C" {
        let old_path = parts.next()?.trim().to_string();
        let path = parts.next()?.trim().to_string();
        if path.is_empty() {
            return None;
        }
        return Some(GitCommitFile {
            path,
            old_path: if old_path.is_empty() {
                None
            } else {
                Some(old_path)
            },
            status,
            kind: commit_file_kind(raw_status),
        });
    }
    let path = parts.next()?.trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(GitCommitFile {
        path,
        old_path: None,
        status,
        kind: commit_file_kind(raw_status),
    })
}

fn clean_git_ref_label(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Some((_, target)) = value.split_once(" -> ") {
        value = target.trim();
    }
    if let Some(stripped) = value.strip_prefix("tag: ") {
        value = stripped.trim();
    }
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped;
            break;
        }
    }
    if value.is_empty() || value == "HEAD" || value.ends_with("/HEAD") {
        return None;
    }
    Some(value.to_string())
}

fn parse_git_refs(raw: &str) -> Vec<String> {
    let mut refs = Vec::new();
    for part in raw.split(',') {
        let Some(label) = clean_git_ref_label(part) else {
            continue;
        };
        if !refs.contains(&label) {
            refs.push(label);
        }
    }
    refs
}

fn parse_git_log(raw: &str) -> Vec<GitCommitSummary> {
    raw.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            if record.trim().is_empty() {
                return None;
            }
            let mut lines = record.lines();
            let header = lines.next()?;
            let fields: Vec<&str> = header.split('\x1f').collect();
            if fields.len() < 8 {
                return None;
            }
            let sha = fields[0].trim().to_string();
            if sha.is_empty() {
                return None;
            }
            let files: Vec<GitCommitFile> = lines.filter_map(parse_name_status_line).collect();
            Some(GitCommitSummary {
                sha,
                short_sha: fields[1].trim().to_string(),
                parents: fields[2]
                    .split_whitespace()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect(),
                refs: parse_git_refs(fields[3]),
                author_name: fields[4].trim().to_string(),
                author_email: fields[5].trim().to_string(),
                author_date: fields[6].trim().to_string(),
                subject: fields[7].trim().to_string(),
                file_count: files.len(),
                files,
            })
        })
        .collect()
}

fn validate_commit_sha(repo_root: &str, value: &str) -> Result<String, String> {
    let sha = value.trim();
    if sha.len() < 7 || sha.len() > 64 || !sha.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Git commit 必须是有效的提交 SHA。".to_string());
    }
    let rev = format!("{sha}^{{commit}}");
    Ok(git_success(repo_root, &["rev-parse", "--verify", &rev])?
        .stdout
        .lines()
        .next()
        .unwrap_or(sha)
        .trim()
        .to_string())
}

pub(crate) fn git_log_sync(
    workdir: String,
    limit: Option<usize>,
) -> Result<GitLogResponse, String> {
    let state = git_status_sync(workdir)?;
    if state.status != "ready" {
        return Ok(GitLogResponse {
            state,
            commits: Vec::new(),
        });
    }
    if !ref_exists(&state.repo_root, "HEAD") {
        return Ok(GitLogResponse {
            state,
            commits: Vec::new(),
        });
    }
    let limit = limit
        .unwrap_or(GIT_LOG_DEFAULT_LIMIT)
        .clamp(1, GIT_LOG_MAX_LIMIT)
        .to_string();
    let mut args = vec![
        "log".to_string(),
        "--date=iso-strict".to_string(),
        "--decorate=full".to_string(),
        "--topo-order".to_string(),
        "--parents".to_string(),
        "--name-status".to_string(),
        "--find-renames".to_string(),
        "--max-count".to_string(),
        limit,
        "--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%s".to_string(),
        "HEAD".to_string(),
    ];
    let cloud_ref = if !state.upstream.trim().is_empty() {
        state.upstream.clone()
    } else {
        resolve_review_base(&state)
    };
    if !cloud_ref.trim().is_empty() && cloud_ref != "HEAD" {
        args.push(cloud_ref);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    Ok(GitLogResponse {
        state,
        commits: parse_git_log(&output.stdout),
    })
}

pub(crate) fn git_commit_diff_sync(
    workdir: String,
    commit: String,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let commit = validate_commit_sha(&state.repo_root, &commit)?;
    let clean_path = path
        .as_deref()
        .map(validate_repo_relative_path)
        .transpose()?;
    let parent_output = git_success(&state.repo_root, &["show", "-s", "--format=%P", &commit])?;
    let first_parent = parent_output
        .stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    let mut args: Vec<String> = if first_parent.is_empty() {
        vec![
            "show".to_string(),
            "--format=".to_string(),
            "--patch".to_string(),
            "--stat".to_string(),
            "--find-renames".to_string(),
            commit.clone(),
        ]
    } else {
        vec![
            "diff".to_string(),
            "--patch".to_string(),
            "--stat".to_string(),
            "--find-renames".to_string(),
            first_parent.clone(),
            commit.clone(),
        ]
    };
    if let Some(path) = clean_path.as_deref() {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    let (stat, patch) = split_stat_and_patch(&output.stdout);
    let (patch, truncated) = truncate_patch(patch);
    Ok(GitDiffResponse {
        base_ref: if first_parent.is_empty() {
            "ROOT".to_string()
        } else {
            first_parent
        },
        head_ref: commit,
        mode: "commit".to_string(),
        files: clean_path.into_iter().collect(),
        patch,
        stat,
        truncated,
        binary_files: Vec::new(),
    })
}

pub(crate) fn git_diff_sync(
    workdir: String,
    mode: Option<String>,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let mode = mode.unwrap_or_else(|| "branch".to_string());
    let clean_path = path
        .as_deref()
        .map(validate_repo_relative_path)
        .transpose()?;
    let files = state
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    if mode == "working_tree" && !ref_exists(&state.repo_root, "HEAD") {
        let mut patch = String::new();
        let mut binary_files = Vec::new();
        append_initial_worktree_file_patches(
            &state.repo_root,
            &state.entries,
            clean_path.as_deref(),
            &mut patch,
            &mut binary_files,
        )?;
        let (patch, truncated) = truncate_patch(patch);
        return Ok(GitDiffResponse {
            base_ref: "ROOT".to_string(),
            head_ref: "WORKTREE".to_string(),
            mode,
            files,
            patch,
            stat: String::new(),
            truncated,
            binary_files,
        });
    }
    let mut base_ref = String::new();
    let mut head_ref = "HEAD".to_string();
    let mut args: Vec<String> = vec![
        "diff".to_string(),
        "--patch".to_string(),
        "--stat".to_string(),
    ];
    if mode == "working_tree" {
        args.push("HEAD".to_string());
    } else {
        base_ref = resolve_review_base(&state);
        if base_ref.is_empty() {
            return Err(
                "找不到可用于审查的基线分支。请先设置 upstream 或 fetch 主分支。".to_string(),
            );
        }
        args.push(format!("{base_ref}...HEAD"));
    }
    if let Some(path) = clean_path.as_deref() {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    let (stat, mut patch) = split_stat_and_patch(&output.stdout);
    let mut binary_files = Vec::new();
    if mode == "working_tree" {
        append_untracked_file_patches(
            &state.repo_root,
            &state.entries,
            clean_path.as_deref(),
            &mut patch,
            &mut binary_files,
        )?;
    }
    let (patch, truncated) = truncate_patch(patch);
    if mode == "working_tree" {
        base_ref = "HEAD".to_string();
        head_ref = "WORKTREE".to_string();
    }
    Ok(GitDiffResponse {
        base_ref,
        head_ref,
        mode,
        files,
        patch,
        stat,
        truncated,
        binary_files,
    })
}

pub(crate) fn git_stage_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["add", "--", path.as_str()]),
        "文件已暂存。",
    )
}

pub(crate) fn git_stage_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["add", "-A", "--"]),
        "所有改动已暂存。",
    )
}

pub(crate) fn git_unstage_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    operation_response(
        &workdir,
        git_success(
            &state.repo_root,
            &["restore", "--staged", "--", path.as_str()],
        ),
        "文件已取消暂存。",
    )
}

pub(crate) fn git_unstage_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["restore", "--staged", "--", "."]),
        "所有改动已取消暂存。",
    )
}

pub(crate) fn git_discard_sync(
    workdir: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let old_path = old_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(validate_repo_relative_path)
        .transpose()?;
    let is_untracked = state
        .entries
        .iter()
        .any(|entry| entry.path == path && entry.untracked);
    let result = if is_untracked {
        git_success(&state.repo_root, &["clean", "-fd", "--", path.as_str()])
    } else {
        let mut args = vec!["restore", "--staged", "--worktree", "--", path.as_str()];
        if let Some(old_path) = old_path.as_deref() {
            if old_path != path {
                args.push(old_path);
            }
        }
        git_success(&state.repo_root, &args)
    };
    operation_response(&workdir, result, "改动已放弃。")
}

pub(crate) fn git_discard_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = git_success(
        &state.repo_root,
        &["restore", "--staged", "--worktree", "--", "."],
    )
    .and_then(|restore_output| {
        git_success(&state.repo_root, &["clean", "-fd", "--", "."]).map(|clean_output| GitOutput {
            stdout: [restore_output.stdout, clean_output.stdout]
                .into_iter()
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            stderr: [restore_output.stderr, clean_output.stderr]
                .into_iter()
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        })
    });
    operation_response(&workdir, result, "所有改动已放弃。")
}

pub(crate) fn git_add_to_gitignore_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let pattern = format!("/{path}");
    let gitignore_path = Path::new(&state.repo_root).join(".gitignore");
    let mut content = match fs::read_to_string(&gitignore_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 .gitignore 失败：{error}")),
    };
    let already_present = content.lines().any(|line| {
        let line = line.trim();
        line == path || line == pattern
    });
    let result = if already_present {
        Ok(GitOutput {
            stdout: String::new(),
            stderr: String::new(),
        })
    } else {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
        fs::write(&gitignore_path, content)
            .map(|_| GitOutput {
                stdout: String::new(),
                stderr: String::new(),
            })
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))
    };
    operation_response(
        &workdir,
        result,
        if already_present {
            "路径已存在于 .gitignore。"
        } else {
            "路径已添加到 .gitignore。"
        },
    )
}

pub(crate) fn git_commit_sync(
    workdir: String,
    message: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message 不能为空。".to_string());
    }
    if state.dirty_counts.staged == 0 {
        return Err("没有已暂存的改动可提交。".to_string());
    }
    git_success(&state.repo_root, &["config", "--get", "user.name"])
        .map_err(|_| "Git user.name 未配置。".to_string())?;
    git_success(&state.repo_root, &["config", "--get", "user.email"])
        .map_err(|_| "Git user.email 未配置。".to_string())?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["commit", "-m", message.as_str()]),
        "提交已创建。",
    )
}

pub(crate) fn git_fetch_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["fetch", "--prune"]),
        "Fetch 完成。",
    )
}

pub(crate) fn git_pull_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["pull", "--ff-only"]),
        "Pull 完成。",
    )
}

pub(crate) fn git_push_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = if state.upstream.trim().is_empty() {
        if state.head.trim().is_empty() || state.head == "(detached)" {
            Err("当前不在可推送的本地分支上。".to_string())
        } else if git_success(&state.repo_root, &["remote", "get-url", "origin"]).is_err() {
            Err("当前分支没有 upstream，且找不到 origin remote。".to_string())
        } else {
            git_success(
                &state.repo_root,
                &["push", "-u", "origin", state.head.as_str()],
            )
        }
    } else {
        git_success(&state.repo_root, &["push"])
    };
    operation_response(&workdir, result, "Push 完成。")
}

fn parse_gateway_args(args_json: String) -> Result<GitGatewayArgs, String> {
    if args_json.trim().is_empty() {
        return Ok(GitGatewayArgs::default());
    }
    serde_json::from_str(&args_json).map_err(|error| format!("Git 参数 JSON 无效：{error}"))
}

pub(crate) fn git_gateway_action_sync(
    action: String,
    workdir: String,
    args_json: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();
    let args = parse_gateway_args(args_json)?;
    let value = match action.as_str() {
        "status" => serde_json::to_value(git_status_sync(workdir)?),
        "branches" => serde_json::to_value(git_branches_sync(workdir)?),
        "init" => serde_json::to_value(git_init_sync(
            workdir,
            args.branch.unwrap_or_else(|| "main".to_string()),
            args.user_name,
            args.user_email,
        )?),
        "switch_branch" => serde_json::to_value(git_switch_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
            args.kind,
        )?),
        "create_branch" => serde_json::to_value(git_create_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
        )?),
        "log" => serde_json::to_value(git_log_sync(workdir, args.limit)?),
        "commit_diff" => serde_json::to_value(git_commit_diff_sync(
            workdir,
            args.commit.unwrap_or_default(),
            args.path,
        )?),
        "diff" => serde_json::to_value(git_diff_sync(workdir, args.mode, args.path)?),
        "stage" => serde_json::to_value(git_stage_sync(workdir, args.path.unwrap_or_default())?),
        "stage_all" => serde_json::to_value(git_stage_all_sync(workdir)?),
        "unstage" => {
            serde_json::to_value(git_unstage_sync(workdir, args.path.unwrap_or_default())?)
        }
        "unstage_all" => serde_json::to_value(git_unstage_all_sync(workdir)?),
        "discard" => serde_json::to_value(git_discard_sync(
            workdir,
            args.path.unwrap_or_default(),
            args.old_path,
        )?),
        "discard_all" => serde_json::to_value(git_discard_all_sync(workdir)?),
        "add_to_gitignore" => serde_json::to_value(git_add_to_gitignore_sync(
            workdir,
            args.path.unwrap_or_default(),
        )?),
        "commit" => {
            serde_json::to_value(git_commit_sync(workdir, args.message.unwrap_or_default())?)
        }
        "fetch" => serde_json::to_value(git_fetch_sync(workdir)?),
        "pull" => serde_json::to_value(git_pull_sync(workdir)?),
        "push" => serde_json::to_value(git_push_sync(workdir)?),
        "" => return Err("Git action 不能为空。".to_string()),
        other => return Err(format!("不支持的 Git action：{other}")),
    }
    .map_err(|error| format!("序列化 Git 响应失败：{error}"))?;
    Ok(value)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_status(workdir: String) -> Result<GitRepositoryState, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_sync(workdir))
        .await
        .map_err(|error| format!("git_status join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_branches(workdir: String) -> Result<GitBranchesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_branches_sync(workdir))
        .await
        .map_err(|error| format!("git_branches join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_switch_branch(
    workdir: String,
    branch: String,
    kind: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_switch_branch_sync(workdir, branch, kind))
        .await
        .map_err(|error| format!("git_switch_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_create_branch(
    workdir: String,
    branch: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_create_branch_sync(workdir, branch))
        .await
        .map_err(|error| format!("git_create_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_init(
    workdir: String,
    branch: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_init_sync(
            workdir,
            branch.unwrap_or_else(|| "main".to_string()),
            user_name,
            user_email,
        )
    })
    .await
    .map_err(|error| format!("git_init join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_diff(
    workdir: String,
    mode: Option<String>,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_sync(workdir, mode, path))
        .await
        .map_err(|error| format!("git_diff join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_log(workdir: String, limit: Option<usize>) -> Result<GitLogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_log_sync(workdir, limit))
        .await
        .map_err(|error| format!("git_log join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit_diff(
    workdir: String,
    commit: String,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_diff_sync(workdir, commit, path))
        .await
        .map_err(|error| format!("git_commit_diff join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_sync(workdir, path))
        .await
        .map_err(|error| format!("git_stage join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_all_sync(workdir))
        .await
        .map_err(|error| format!("git_stage_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_sync(workdir, path))
        .await
        .map_err(|error| format!("git_unstage join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_all_sync(workdir))
        .await
        .map_err(|error| format!("git_unstage_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard(
    workdir: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_sync(workdir, path, old_path))
        .await
        .map_err(|error| format!("git_discard join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_all_sync(workdir))
        .await
        .map_err(|error| format!("git_discard_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_add_to_gitignore(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_add_to_gitignore_sync(workdir, path))
        .await
        .map_err(|error| format!("git_add_to_gitignore join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit(workdir: String, message: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_sync(workdir, message))
        .await
        .map_err(|error| format!("git_commit join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_fetch(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_fetch_sync(workdir))
        .await
        .map_err(|error| format!("git_fetch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_pull(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_pull_sync(workdir))
        .await
        .map_err(|error| format!("git_pull join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_push(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_sync(workdir))
        .await
        .map_err(|error| format!("git_push join 失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn parses_porcelain_v2_branch_and_counts() {
        let raw = b"# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 a b src/main.rs\0? new.txt\0";
        let (head, upstream, ahead, behind, entries) = parse_status_porcelain_v2(raw);
        assert_eq!(head, "feature");
        assert_eq!(upstream, "origin/feature");
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
        assert_eq!(entries.len(), 2);
        let counts = dirty_counts(&entries);
        assert_eq!(counts.unstaged, 1);
        assert_eq!(counts.untracked, 1);
    }

    #[test]
    fn rejects_unsafe_repo_relative_paths() {
        assert!(validate_repo_relative_path("src/main.rs").is_ok());
        assert!(validate_repo_relative_path("../secret").is_err());
        assert!(validate_repo_relative_path("/tmp/secret").is_err());
    }

    #[test]
    fn falls_back_to_upstream_as_review_base() {
        let state = GitRepositoryState {
            repo_root: ".".to_string(),
            workdir: ".".to_string(),
            head: "feature".to_string(),
            upstream: "origin/feature".to_string(),
            ahead: 0,
            behind: 0,
            dirty_counts: GitDirtyCounts::default(),
            entries: Vec::new(),
            status: "ready".to_string(),
            error: None,
        };
        assert_eq!(resolve_review_base(&state), "origin/feature");
    }

    #[test]
    fn gateway_args_accept_empty_json() {
        assert!(parse_gateway_args(String::new()).is_ok());
        assert!(parse_gateway_args(json!({"path":"src/main.rs"}).to_string()).is_ok());
        let init_args = parse_gateway_args(
            json!({"branch":"main","userName":"LiveAgent Test","userEmail":"test@example.com"})
                .to_string(),
        )
        .expect("parse init args");
        assert_eq!(init_args.user_name.as_deref(), Some("LiveAgent Test"));
        assert_eq!(init_args.user_email.as_deref(), Some("test@example.com"));
    }

    #[test]
    fn parses_git_log_commits_refs_and_renames() {
        let raw = "\x1e0123456789abcdef\x1f0123456\x1ffedcba9\x1fHEAD -> refs/heads/feature, refs/remotes/origin/feature\x1fAlice\x1falice@example.com\x1f2026-05-29T10:11:12+08:00\x1frename file\nR100\told.txt\tnew.txt\n";
        let commits = parse_git_log(raw);
        assert_eq!(commits.len(), 1);
        let commit = &commits[0];
        assert_eq!(commit.short_sha, "0123456");
        assert_eq!(commit.refs, vec!["feature", "origin/feature"]);
        assert_eq!(commit.parents, vec!["fedcba9"]);
        assert_eq!(commit.files.len(), 1);
        assert_eq!(commit.files[0].status, "R");
        assert_eq!(commit.files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(commit.files[0].path, "new.txt");
    }

    fn run_temp_git(repo_root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo_root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git command should start");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_temp_repo() -> Option<TempDir> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        run_temp_git(temp.path(), &["init"]);
        run_temp_git(temp.path(), &["config", "user.name", "LiveAgent Test"]);
        run_temp_git(temp.path(), &["config", "user.email", "test@example.com"]);
        fs::write(temp.path().join("README.md"), "initial\n").expect("write readme");
        run_temp_git(temp.path(), &["add", "README.md"]);
        run_temp_git(temp.path(), &["commit", "-m", "initial"]);
        Some(temp)
    }

    #[test]
    fn git_init_creates_repo_with_branch_and_local_identity() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized = git_init_sync(
            workdir.clone(),
            "trunk".to_string(),
            Some("LiveAgent Test".to_string()),
            Some("test@example.com".to_string()),
        )
        .expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert_eq!(initialized.state.status, "ready");
        assert_eq!(initialized.state.head, "trunk");

        let user_name =
            git_success(&workdir, &["config", "--get", "user.name"]).expect("user.name");
        let user_email =
            git_success(&workdir, &["config", "--get", "user.email"]).expect("user.email");
        assert_eq!(user_name.stdout, "LiveAgent Test");
        assert_eq!(user_email.stdout, "test@example.com");

        let duplicate = git_init_sync(workdir, "main".to_string(), None, None)
            .expect_err("second init should fail");
        assert!(duplicate.contains("Git 仓库内"), "{duplicate}");
    }

    #[test]
    fn git_worktree_diff_handles_unborn_head_repo() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized =
            git_init_sync(workdir.clone(), "main".to_string(), None, None).expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert!(!ref_exists(&workdir, "HEAD"));

        fs::write(temp.path().join("draft.txt"), "draft\n").expect("write draft");
        let diff = git_diff_sync(
            workdir.clone(),
            Some("working_tree".to_string()),
            Some("draft.txt".to_string()),
        )
        .expect("working tree diff in unborn repo");
        assert_eq!(diff.base_ref, "ROOT");
        assert_eq!(diff.head_ref, "WORKTREE");
        assert!(
            diff.files.contains(&"draft.txt".to_string()),
            "diff files: {:?}",
            diff.files
        );
        assert!(
            diff.patch.contains("diff --git a/draft.txt b/draft.txt")
                && diff.patch.contains("+draft"),
            "working tree diff patch:\n{}",
            diff.patch
        );
    }

    #[test]
    fn git_cli_operations_work_in_temp_repo() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");
        assert_eq!(initial.status, "ready");
        assert!(!initial.head.is_empty());

        let created = git_create_branch_sync(workdir.clone(), "feature/git-review".to_string())
            .expect("create branch");
        assert!(created.ok, "create branch failed: {}", created.message);
        assert_eq!(created.state.head, "feature/git-review");

        let switched_back = git_switch_branch_sync(workdir.clone(), initial.head.clone(), None)
            .expect("switch back");
        assert!(
            switched_back.ok,
            "switch back failed: {}",
            switched_back.message
        );
        let switched_feature =
            git_switch_branch_sync(workdir.clone(), "feature/git-review".to_string(), None)
                .expect("switch feature");
        assert!(
            switched_feature.ok,
            "switch feature failed: {}",
            switched_feature.message
        );

        fs::write(repo.path().join("feature.txt"), "feature\n").expect("write feature");
        let staged = git_stage_sync(workdir.clone(), "feature.txt".to_string()).expect("stage");
        assert!(staged.ok, "stage failed: {}", staged.message);
        let committed =
            git_commit_sync(workdir.clone(), "add feature file".to_string()).expect("commit");
        assert!(committed.ok, "commit failed: {}", committed.message);

        let history = git_log_sync(workdir.clone(), Some(10)).expect("git log");
        let feature_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "add feature file")
            .expect("feature commit should be in log");
        assert!(
            feature_commit
                .files
                .iter()
                .any(|file| file.path == "feature.txt" && file.status == "A"),
            "feature commit files: {:?}",
            feature_commit.files
        );
        let commit_diff = git_commit_diff_sync(
            workdir.clone(),
            feature_commit.sha.clone(),
            Some("feature.txt".to_string()),
        )
        .expect("commit diff");
        assert!(
            commit_diff.patch.contains("feature.txt") && commit_diff.patch.contains("+feature"),
            "commit diff patch:\n{}",
            commit_diff.patch
        );

        let branch_diff =
            git_diff_sync(workdir.clone(), Some("branch".to_string()), None).expect("branch diff");
        assert_eq!(branch_diff.base_ref, initial.head);
        assert!(
            branch_diff.patch.contains("feature.txt"),
            "branch diff patch:\n{}",
            branch_diff.patch
        );

        fs::write(repo.path().join("work.txt"), "draft\n").expect("write worktree");
        let worktree_diff = git_diff_sync(workdir.clone(), Some("working_tree".to_string()), None)
            .expect("working tree diff");
        assert_eq!(worktree_diff.base_ref, "HEAD");
        assert!(
            worktree_diff.patch.contains("work.txt") && worktree_diff.patch.contains("+draft"),
            "working tree diff patch:\n{}",
            worktree_diff.patch
        );

        let staged_work =
            git_stage_sync(workdir.clone(), "work.txt".to_string()).expect("stage worktree file");
        assert!(
            staged_work.ok,
            "stage worktree failed: {}",
            staged_work.message
        );
        assert_eq!(staged_work.state.dirty_counts.staged, 1);

        let unstaged_work = git_unstage_sync(workdir.clone(), "work.txt".to_string())
            .expect("unstage worktree file");
        assert!(
            unstaged_work.ok,
            "unstage worktree failed: {}",
            unstaged_work.message
        );
        assert_eq!(unstaged_work.state.dirty_counts.untracked, 1);

        let discarded_untracked =
            git_discard_sync(workdir.clone(), "work.txt".to_string(), None).expect("discard work");
        assert!(
            discarded_untracked.ok,
            "discard untracked failed: {}",
            discarded_untracked.message
        );
        assert!(!repo.path().join("work.txt").exists());

        fs::write(repo.path().join("README.md"), "changed\n").expect("modify readme");
        let staged_readme =
            git_stage_sync(workdir.clone(), "README.md".to_string()).expect("stage readme");
        assert!(
            staged_readme.ok,
            "stage readme failed: {}",
            staged_readme.message
        );
        let discarded_readme = git_discard_sync(workdir.clone(), "README.md".to_string(), None)
            .expect("discard readme");
        assert!(
            discarded_readme.ok,
            "discard readme failed: {}",
            discarded_readme.message
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("README.md")).expect("read readme"),
            "initial\n"
        );

        fs::write(repo.path().join("README.md"), "bulk changed\n").expect("bulk modify readme");
        fs::write(repo.path().join("bulk.txt"), "bulk\n").expect("write bulk");
        let staged_all = git_stage_all_sync(workdir.clone()).expect("stage all");
        assert!(staged_all.ok, "stage all failed: {}", staged_all.message);
        assert!(
            staged_all.state.dirty_counts.staged >= 2,
            "stage all counts: {:?}",
            staged_all.state.dirty_counts
        );
        let unstaged_all = git_unstage_all_sync(workdir.clone()).expect("unstage all");
        assert!(
            unstaged_all.ok,
            "unstage all failed: {}",
            unstaged_all.message
        );
        assert_eq!(unstaged_all.state.dirty_counts.staged, 0);
        assert!(unstaged_all.state.dirty_counts.unstaged >= 1);
        assert!(unstaged_all.state.dirty_counts.untracked >= 1);
        let discarded_all = git_discard_all_sync(workdir.clone()).expect("discard all");
        assert!(
            discarded_all.ok,
            "discard all failed: {}",
            discarded_all.message
        );
        assert!(discarded_all.state.entries.is_empty());
        assert!(!repo.path().join("bulk.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.path().join("README.md"))
                .expect("read readme after discard all"),
            "initial\n"
        );

        fs::write(repo.path().join("ignore.log"), "ignored\n").expect("write ignored file");
        let ignored =
            git_add_to_gitignore_sync(workdir.clone(), "ignore.log".to_string()).expect("ignore");
        assert!(ignored.ok, "add gitignore failed: {}", ignored.message);
        let ignored_duplicate =
            git_add_to_gitignore_sync(workdir.clone(), "ignore.log".to_string())
                .expect("ignore duplicate");
        assert!(
            ignored_duplicate.ok,
            "duplicate gitignore failed: {}",
            ignored_duplicate.message
        );
        let ignored_tracked = git_add_to_gitignore_sync(workdir.clone(), "README.md".to_string())
            .expect("ignore tracked");
        assert!(
            ignored_tracked.ok,
            "tracked gitignore failed: {}",
            ignored_tracked.message
        );
        let gitignore = fs::read_to_string(repo.path().join(".gitignore")).expect("read gitignore");
        assert_eq!(
            gitignore
                .lines()
                .filter(|line| *line == "/ignore.log")
                .count(),
            1
        );
        assert!(gitignore.lines().any(|line| line == "/README.md"));
    }
}
