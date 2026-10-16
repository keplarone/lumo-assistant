//! Netlify: deploy a website project as a zip with the user's personal access token.

use super::http_error;
use crate::error::{LumoError, Result};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

fn req(http: &reqwest::Client, method: reqwest::Method, url: String, token: &str) -> reqwest::RequestBuilder {
    http.request(method, url).bearer_auth(token).timeout(std::time::Duration::from_secs(120))
}

async fn json_or_error(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status().as_u16();
    let body = resp.text().await?;
    if status >= 300 {
        return Err(http_error("Netlify", status, &body));
    }
    Ok(serde_json::from_str(&body)?)
}

pub async fn whoami(http: &reqwest::Client, base: &str, token: &str) -> Result<String> {
    let v = json_or_error(req(http, reqwest::Method::GET, format!("{base}/user"), token).send().await?).await?;
    Ok(v["email"].as_str().or(v["full_name"].as_str()).unwrap_or("Netlify account").to_string())
}

/// Zip a folder for deployment, skipping version control, dependencies and hidden files.
pub fn zip_dir(dir: &Path) -> Result<(Vec<u8>, usize)> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut files = 0;
    let mut total = 0u64;
    for e in walkdir::WalkDir::new(dir).min_depth(1).into_iter().filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        !(n.starts_with('.') || n == "node_modules")
    }) {
        let e = e.map_err(|e| LumoError::Other(e.into()))?;
        if !e.file_type().is_file() {
            continue;
        }
        let rel = e.path().strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/");
        let bytes = std::fs::read(e.path())?;
        total += bytes.len() as u64;
        if total > 200 * 1024 * 1024 {
            return Err(LumoError::Invalid("the project is larger than 200 MB".into()));
        }
        zip.start_file(rel, opts).map_err(|e| LumoError::Other(e.into()))?;
        zip.write_all(&bytes)?;
        files += 1;
    }
    zip.finish().map_err(|e| LumoError::Other(e.into()))?;
    Ok((buf.into_inner(), files))
}

pub async fn create_site(http: &reqwest::Client, base: &str, token: &str, name: Option<&str>) -> Result<(String, String)> {
    let body = match name {
        Some(n) => json!({"name": n}),
        None => json!({}),
    };
    let v = json_or_error(req(http, reqwest::Method::POST, format!("{base}/sites"), token).json(&body).send().await?).await?;
    Ok((
        v["id"].as_str().ok_or_else(|| LumoError::Provider("Netlify returned no site id".into()))?.into(),
        v["ssl_url"].as_str().or(v["url"].as_str()).unwrap_or_default().into(),
    ))
}

pub struct Deploy {
    pub id: String,
    pub state: String,
    pub url: String,
    pub error: Option<String>,
}

fn parse_deploy(v: &Value) -> Deploy {
    Deploy {
        id: v["id"].as_str().unwrap_or_default().into(),
        state: v["state"].as_str().unwrap_or("unknown").into(),
        url: v["ssl_url"].as_str().or(v["deploy_ssl_url"].as_str()).or(v["url"].as_str()).unwrap_or_default().into(),
        error: v["error_message"].as_str().map(String::from),
    }
}

/// Upload a zip and wait (up to ~2 minutes) for the deploy to be live.
pub async fn deploy_zip(http: &reqwest::Client, base: &str, token: &str, site_id: &str, zip: Vec<u8>, cancel: &tokio_util::sync::CancellationToken) -> Result<Deploy> {
    let v = json_or_error(
        req(http, reqwest::Method::POST, format!("{base}/sites/{site_id}/deploys"), token)
            .header("content-type", "application/zip")
            .body(zip)
            .send()
            .await?,
    )
    .await?;
    let mut d = parse_deploy(&v);
    for _ in 0..60 {
        match d.state.as_str() {
            "ready" => return Ok(d),
            "error" => return Err(LumoError::Unavailable(format!("Netlify could not deploy: {}", d.error.unwrap_or_default()))),
            _ => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
            _ = cancel.cancelled() => return Err(LumoError::Cancelled),
        }
        let v = json_or_error(req(http, reqwest::Method::GET, format!("{base}/deploys/{}", d.id), token).send().await?).await?;
        d = parse_deploy(&v);
    }
    Err(LumoError::Unavailable("Netlify is still processing the deploy; check it again in a minute.".into()))
}
