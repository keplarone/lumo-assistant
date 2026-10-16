//! Brave Search, for web search (the `search_web` tool) when the user adds a Brave Search key.

use crate::error::Result;
use serde_json::Value;

pub struct Hit {
    pub title: String,
    pub url: String,
    pub description: String,
}

pub async fn search(http: &reqwest::Client, base: &str, key: &str, query: &str, count: u32) -> Result<Vec<Hit>> {
    let resp = http
        .get(format!("{base}/web/search"))
        .query(&[("q", query), ("count", &count.clamp(1, 20).to_string())])
        .header("X-Subscription-Token", key)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?;
    let status = resp.status().as_u16();
    let body = resp.text().await?;
    if status >= 300 {
        return Err(super::http_error("Brave Search", status, &body));
    }
    let v: Value = serde_json::from_str(&body)?;
    Ok(v["web"]["results"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| Hit {
            title: r["title"].as_str().unwrap_or("").into(),
            url: r["url"].as_str().unwrap_or("").into(),
            description: html2text::from_read(r["description"].as_str().unwrap_or("").as_bytes(), 200).unwrap_or_default().trim().into(),
        })
        .collect())
}
