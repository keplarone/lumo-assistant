//! GitHub: publish a Lumo project to a new repository with the user's personal access token.

use super::http_error;
use crate::error::{LumoError, Result};
use serde_json::{json, Value};
use std::path::Path;

fn req(http: &reqwest::Client, method: reqwest::Method, url: String, token: &str) -> reqwest::RequestBuilder {
    http.request(method, url)
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
        .timeout(std::time::Duration::from_secs(20))
}

async fn json_or_error(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status().as_u16();
    let body = resp.text().await?;
    if status >= 300 {
        return Err(http_error("GitHub", status, &body));
    }
    Ok(serde_json::from_str(&body)?)
}

pub async fn whoami(http: &reqwest::Client, base: &str, token: &str) -> Result<String> {
    let v = json_or_error(req(http, reqwest::Method::GET, format!("{base}/user"), token).send().await?).await?;
    v["login"].as_str().map(String::from).ok_or_else(|| LumoError::Provider("GitHub returned no login".into()))
}

pub struct Repo {
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
}

pub async fn create_repo(http: &reqwest::Client, base: &str, token: &str, name: &str, private: bool, description: &str) -> Result<Repo> {
    let v = json_or_error(
        req(http, reqwest::Method::POST, format!("{base}/user/repos"), token)
            .json(&json!({"name": name, "private": private, "description": description, "auto_init": false}))
            .send()
            .await?,
    )
    .await?;
    Ok(Repo {
        full_name: v["full_name"].as_str().unwrap_or(name).into(),
        html_url: v["html_url"].as_str().unwrap_or_default().into(),
        clone_url: v["clone_url"].as_str().ok_or_else(|| LumoError::Provider("GitHub returned no clone URL".into()))?.into(),
    })
}

/// Push the project's current branch to `url` using the token (never written to disk or the repo config).
pub fn push(project: &Path, url: &str, token: &str) -> Result<String> {
    let repo = git2::Repository::open(project).map_err(|e| LumoError::Other(e.into()))?;
    let head = repo.head().map_err(|_| LumoError::Invalid("the project has no saved version to publish".into()))?;
    let branch = head.shorthand().unwrap_or("master").to_string();
    let mut remote = repo.remote_anonymous(url).map_err(|e| LumoError::Other(e.into()))?;
    let mut cb = git2::RemoteCallbacks::new();
    let token = token.to_string();
    cb.credentials(move |_url, _user, _allowed| git2::Cred::userpass_plaintext("x-access-token", &token));
    let rejected = std::sync::Arc::new(parking_lot::Mutex::new(None::<String>));
    let r2 = rejected.clone();
    cb.push_update_reference(move |_ref, status| {
        if let Some(s) = status {
            *r2.lock() = Some(s.to_string());
        }
        Ok(())
    });
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(cb);
    remote
        .push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], Some(&mut opts))
        .map_err(|e| LumoError::Unavailable(format!("Pushing to GitHub failed: {}", e.message())))?;
    if let Some(r) = rejected.lock().take() {
        return Err(LumoError::Unavailable(format!("GitHub rejected the push: {r}")));
    }
    Ok(branch)
}
