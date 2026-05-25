use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url};
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_UPDATE_REPOSITORY: &str = "Stack-Cairn/LiveAgent";
const UPDATE_MANIFEST_ASSET: &str = "latest.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResponse {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
    channel: AppUpdateChannel,
    release_tag: Option<String>,
    release_name: Option<String>,
    release_url: Option<String>,
    repository: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum AppUpdateChannel {
    Stable,
    Prerelease,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    draft: bool,
    prerelease: bool,
    html_url: Option<String>,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone)]
struct SelectedRelease {
    tag_name: String,
    name: Option<String>,
    prerelease: bool,
    html_url: Option<String>,
    published_at: Option<String>,
    manifest_url: String,
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn update_repository() -> String {
    std::env::var("LIVEAGENT_UPDATE_REPOSITORY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_UPDATE_REPOSITORY").map(str::to_string))
        .map(|value| value.trim().trim_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATE_REPOSITORY.to_string())
}

fn updater_public_key_override() -> Option<String> {
    std::env::var("LIVEAGENT_UPDATER_PUBLIC_KEY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_UPDATER_PUBLIC_KEY").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn github_api_token() -> Option<String> {
    std::env::var("LIVEAGENT_UPDATE_GITHUB_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn release_channel(release: &SelectedRelease) -> AppUpdateChannel {
    if release.prerelease {
        AppUpdateChannel::Prerelease
    } else {
        AppUpdateChannel::Stable
    }
}

fn version_from_tag(tag_name: &str) -> String {
    tag_name.trim().trim_start_matches('v').to_string()
}

fn no_update_response(
    app: &AppHandle,
    repository: String,
    channel: AppUpdateChannel,
) -> AppUpdateCheckResponse {
    AppUpdateCheckResponse {
        configured: true,
        available: false,
        current_version: current_version(app),
        version: None,
        date: None,
        body: None,
        channel,
        release_tag: None,
        release_name: None,
        release_url: None,
        repository,
        message: None,
    }
}

fn response_for_release(
    app: &AppHandle,
    repository: String,
    release: &SelectedRelease,
    available: bool,
    update_version: Option<String>,
    update_date: Option<String>,
    update_body: Option<String>,
) -> AppUpdateCheckResponse {
    AppUpdateCheckResponse {
        configured: true,
        available,
        current_version: current_version(app),
        version: update_version.or_else(|| Some(version_from_tag(&release.tag_name))),
        date: update_date.or_else(|| release.published_at.clone()),
        body: update_body,
        channel: release_channel(release),
        release_tag: Some(release.tag_name.clone()),
        release_name: release.name.clone(),
        release_url: release.html_url.clone(),
        repository,
        message: None,
    }
}

fn selected_release_from_releases(
    releases: Vec<GitHubRelease>,
    include_prerelease: bool,
) -> Option<SelectedRelease> {
    for release in releases {
        if release.draft {
            continue;
        }
        if release.prerelease && !include_prerelease {
            continue;
        }

        if let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name == UPDATE_MANIFEST_ASSET)
        {
            return Some(SelectedRelease {
                tag_name: release.tag_name,
                name: release.name,
                prerelease: release.prerelease,
                html_url: release.html_url,
                published_at: release.published_at,
                manifest_url: asset.browser_download_url.clone(),
            });
        }
    }

    None
}

async fn select_release_manifest(
    repository: &str,
    include_prerelease: bool,
) -> Result<Option<SelectedRelease>, String> {
    let url = format!("https://api.github.com/repos/{repository}/releases?per_page=30");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to create GitHub client: {error}"))?;

    let mut request = client
        .get(url)
        .header(USER_AGENT, "LiveAgent-Updater")
        .header(ACCEPT, "application/vnd.github+json");
    if let Some(token) = github_api_token() {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    let releases = request
        .send()
        .await
        .map_err(|error| format!("failed to query GitHub releases: {error}"))?;

    if !releases.status().is_success() {
        let status = releases.status();
        let body = releases.text().await.unwrap_or_default();
        if status == StatusCode::FORBIDDEN && body.contains("API rate limit exceeded") {
            return Err(
                "GitHub release lookup hit the unauthenticated API rate limit. Set LIVEAGENT_UPDATE_GITHUB_TOKEN for local testing.".to_string(),
            );
        }

        return Err(format!("GitHub release lookup failed with status {status}"));
    }

    let releases = releases
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("failed to parse GitHub releases: {error}"))?;

    Ok(selected_release_from_releases(releases, include_prerelease))
}

fn build_updater(
    app: &AppHandle,
    manifest_url: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let manifest_url = Url::parse(manifest_url)
        .map_err(|error| format!("invalid updater manifest URL: {error}"))?;

    let mut builder = app.updater_builder();
    if let Some(public_key) = updater_public_key_override() {
        builder = builder.pubkey(public_key);
    }

    builder
        .endpoints(vec![manifest_url])
        .map_err(|error| format!("invalid updater endpoint: {error}"))?
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_check(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();

    let Some(release) = select_release_manifest(&repository, include_prerelease).await? else {
        return Ok(no_update_response(
            &app,
            repository,
            if include_prerelease {
                AppUpdateChannel::Prerelease
            } else {
                AppUpdateChannel::Stable
            },
        ));
    };
    let updater = build_updater(&app, &release.manifest_url)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for updates: {error}"))?;

    Ok(match update {
        Some(update) => response_for_release(
            &app,
            repository,
            &release,
            true,
            Some(update.version),
            update.date.map(|date| date.to_string()),
            update.body,
        ),
        None => response_for_release(&app, repository, &release, false, None, None, None),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_install(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();

    let Some(release) = select_release_manifest(&repository, include_prerelease).await? else {
        return Ok(no_update_response(
            &app,
            repository,
            if include_prerelease {
                AppUpdateChannel::Prerelease
            } else {
                AppUpdateChannel::Stable
            },
        ));
    };
    let updater = build_updater(&app, &release.manifest_url)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for updates: {error}"))?;

    let Some(update) = update else {
        return Ok(response_for_release(
            &app, repository, &release, false, None, None, None,
        ));
    };

    let version = update.version.clone();
    let date = update.date.map(|date| date.to_string());
    let body = update.body.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("failed to install update: {error}"))?;

    Ok(response_for_release(
        &app,
        repository,
        &release,
        false,
        Some(version),
        date,
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag_name: &str, prerelease: bool, has_manifest: bool) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag_name.to_string(),
            name: Some(format!("LiveAgent {tag_name}")),
            draft: false,
            prerelease,
            html_url: Some(format!(
                "https://github.com/Stack-Cairn/LiveAgent/releases/tag/{tag_name}"
            )),
            published_at: Some("2026-05-25T12:27:41Z".to_string()),
            assets: if has_manifest {
                vec![GitHubAsset {
                    name: UPDATE_MANIFEST_ASSET.to_string(),
                    browser_download_url: format!(
                        "https://github.com/Stack-Cairn/LiveAgent/releases/download/{tag_name}/latest.json"
                    ),
                }]
            } else {
                Vec::new()
            },
        }
    }

    #[test]
    fn stable_channel_ignores_prerelease_only_manifest() {
        let selected = selected_release_from_releases(vec![release("v0.1.1", true, true)], false);
        assert!(selected.is_none());
    }

    #[test]
    fn prerelease_channel_can_select_prerelease_manifest() {
        let selected = selected_release_from_releases(vec![release("v0.1.1", true, true)], true)
            .expect("pre-release manifest should be selected");
        assert_eq!(selected.tag_name, "v0.1.1");
        assert!(selected.prerelease);
    }

    #[test]
    fn stable_channel_selects_next_stable_manifest_after_prerelease() {
        let selected = selected_release_from_releases(
            vec![
                release("v0.1.2-beta.1", true, true),
                release("v0.1.1", false, true),
            ],
            false,
        )
        .expect("stable manifest should be selected");
        assert_eq!(selected.tag_name, "v0.1.1");
        assert!(!selected.prerelease);
    }
}
