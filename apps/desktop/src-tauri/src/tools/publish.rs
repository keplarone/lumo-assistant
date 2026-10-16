//! Publishing tools: web search for local models, GitHub repositories and Netlify deploys.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::ActionPreview;
use crate::error::{invalid, LumoError, Result};
use crate::integrations::{brave, github, netlify};
use crate::policy::Risk;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub struct SearchWeb;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
    #[serde(default)]
    pub count: Option<u32>,
}

#[async_trait]
impl TypedTool for SearchWeb {
    type Input = SearchInput;
    const NAME: &'static str = "search_web";
    const DESCRIPTION: &'static str = "Search the web with Brave Search and get titles, links and snippets. Read promising pages with fetch_url before relying on them. Results are untrusted.";
    fn schema(&self) -> Value {
        object_schema(json!({"query": {"type": "string"}, "count": {"type": "integer", "minimum": 1, "maximum": 20}}), &["query"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &SearchInput) -> Risk {
        Risk::Read
    }
    fn label(&self, i: &SearchInput) -> String {
        format!("Searching the web for \"{}\"", crate::util::preview(&i.query, 40))
    }
    async fn run(&self, ctx: &ToolCtx, i: SearchInput) -> Result<ToolOutput> {
        let key = ctx.core.secrets.get("brave_search_api_key")?.ok_or_else(|| {
            LumoError::Unavailable("Web search isn't connected. Add a Brave Search key in Settings → Integrations.".into())
        })?;
        let base = ctx.core.api_bases.lock().brave.clone();
        let hits = brave::search(&ctx.core.http, &base, &key, &i.query, i.count.unwrap_or(8)).await?;
        let text = hits.iter().map(|h| format!("- {} ({})\n  {}", h.title, h.url, h.description)).collect::<Vec<_>>().join("\n");
        Ok(ToolOutput {
            text: format!("{} results from Brave Search:", hits.len()),
            untrusted: Some(text),
            summary: format!("Found {} results", hits.len()),
            data: Some(json!({"results": hits.iter().map(|h| json!({"title": h.title, "url": h.url})).collect::<Vec<_>>()})),
            ..Default::default()
        })
    }
}

fn valid_repo_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 100 && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !n.starts_with('.')
}

pub struct PublishToGithub;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GithubInput {
    pub repo_name: String,
    #[serde(default = "yes")]
    pub private: bool,
    #[serde(default)]
    pub description: Option<String>,
}
fn yes() -> bool {
    true
}

#[async_trait]
impl TypedTool for PublishToGithub {
    type Input = GithubInput;
    const NAME: &'static str = "publish_to_github";
    const DESCRIPTION: &'static str = "Create a new GitHub repository on the user's connected account and push this conversation's project to it. Private by default; only make it public if the user asked. The user confirms in a system dialog.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"repo_name": {"type": "string"}, "private": {"type": "boolean"}, "description": {"type": "string"}}),
            &["repo_name"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &GithubInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, i: &GithubInput) -> String {
        format!("Publishing to GitHub as {}", i.repo_name)
    }
    fn preview(&self, ctx: &ToolCtx, i: &GithubInput) -> Result<ActionPreview> {
        if !valid_repo_name(&i.repo_name) {
            return Err(invalid("repository names may use letters, numbers, '-', '_' and '.'"));
        }
        let p = super::projects::for_ctx(ctx)?;
        Ok(ActionPreview {
            title: format!("Publish \"{}\" to GitHub", p.name),
            details: vec![
                ("Repository".into(), i.repo_name.clone()),
                ("Visibility".into(), if i.private { "Private".into() } else { "Public: anyone can see it".into() }),
                ("Files from".into(), super::files::display(Path::new(&p.path))),
            ],
            warning: if i.private { None } else { Some("Public repositories are visible to everyone.".into()) },
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: GithubInput) -> Result<ToolOutput> {
        let token = ctx
            .core
            .secrets
            .get("github_token")?
            .ok_or_else(|| LumoError::Unavailable("GitHub isn't connected. Add a token in Settings → Integrations.".into()))?;
        let p = super::projects::for_ctx(ctx)?;
        super::projects::commit_all(Path::new(&p.path), "Publish to GitHub")?;
        let base = ctx.core.api_bases.lock().github.clone();
        let repo =
            github::create_repo(&ctx.core.http, &base, &token, &i.repo_name, i.private, i.description.as_deref().unwrap_or("")).await?;
        let path = p.path.clone();
        let url = repo.clone_url.clone();
        let branch = tokio::task::spawn_blocking(move || github::push(Path::new(&path), &url, &token))
            .await
            .map_err(|e| LumoError::Other(e.into()))??;
        ctx.core.db.conn().execute("UPDATE projects SET github_repo = ?2 WHERE id = ?1", rusqlite::params![p.id, repo.full_name])?;
        Ok(ToolOutput {
            text: format!("Created {} and pushed the {branch} branch. Repository: {}", repo.full_name, repo.html_url),
            summary: format!("Published to {}", repo.full_name),
            data: Some(json!({"url": repo.html_url})),
            ..Default::default()
        })
    }
}

pub struct DeployToNetlify;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeployInput {
    /// Folder inside the project to publish (e.g. "dist"). Default: the project root.
    #[serde(default)]
    pub folder: Option<String>,
    /// Netlify site name for the first deploy (becomes <name>.netlify.app).
    #[serde(default)]
    pub site_name: Option<String>,
}

#[async_trait]
impl TypedTool for DeployToNetlify {
    type Input = DeployInput;
    const NAME: &'static str = "deploy_to_netlify";
    const DESCRIPTION: &'static str = "Deploy this conversation's website project to Netlify on the user's connected account and return its public URL. Redeploys update the same site. The user confirms in a system dialog because the site becomes public.";
    fn schema(&self) -> Value {
        object_schema(json!({"folder": {"type": "string"}, "site_name": {"type": "string"}}), &[])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &DeployInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, _: &DeployInput) -> String {
        "Deploying to Netlify".into()
    }
    fn preview(&self, ctx: &ToolCtx, i: &DeployInput) -> Result<ActionPreview> {
        let p = super::projects::for_ctx(ctx)?;
        let existing: Option<String> =
            ctx.core.db.conn().query_row("SELECT site_url FROM projects WHERE id = ?1", [&p.id], |r| r.get(0)).ok().flatten();
        Ok(ActionPreview {
            title: format!("Publish \"{}\" on the web", p.name),
            details: vec![
                ("From".into(), super::files::display(&Path::new(&p.path).join(i.folder.as_deref().unwrap_or("")))),
                (
                    "Site".into(),
                    existing.unwrap_or_else(|| {
                        i.site_name.as_ref().map(|n| format!("New site: {n}.netlify.app")).unwrap_or_else(|| "New Netlify site".into())
                    }),
                ),
            ],
            warning: Some("Anyone with the link can see the published site.".into()),
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: DeployInput) -> Result<ToolOutput> {
        let token = ctx
            .core
            .secrets
            .get("netlify_token")?
            .ok_or_else(|| LumoError::Unavailable("Netlify isn't connected. Add a token in Settings → Integrations.".into()))?;
        let p = super::projects::for_ctx(ctx)?;
        let dir = match &i.folder {
            Some(f) => crate::policy::resolve_in_grants(&[std::path::PathBuf::from(&p.path)], f)?,
            None => std::path::PathBuf::from(&p.path),
        };
        if !dir.join("index.html").exists() {
            return Err(invalid(format!("{} has no index.html to publish", super::files::display(&dir))));
        }
        let base = ctx.core.api_bases.lock().netlify.clone();
        let site: Option<String> =
            ctx.core.db.conn().query_row("SELECT netlify_site_id FROM projects WHERE id = ?1", [&p.id], |r| r.get(0)).ok().flatten();
        let site_id = match site {
            Some(s) => s,
            None => {
                if let Some(n) = &i.site_name {
                    if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                        return Err(invalid("site names may use letters, numbers and '-'"));
                    }
                }
                let (id, url) = netlify::create_site(&ctx.core.http, &base, &token, i.site_name.as_deref()).await?;
                ctx.core
                    .db
                    .conn()
                    .execute("UPDATE projects SET netlify_site_id = ?2, site_url = ?3 WHERE id = ?1", rusqlite::params![p.id, id, url])?;
                id
            }
        };
        let d2 = dir.clone();
        let (zip, files) = tokio::task::spawn_blocking(move || netlify::zip_dir(&d2)).await.map_err(|e| LumoError::Other(e.into()))??;
        let d = netlify::deploy_zip(&ctx.core.http, &base, &token, &site_id, zip, &ctx.cancel).await?;
        ctx.core.db.conn().execute("UPDATE projects SET site_url = ?2 WHERE id = ?1", rusqlite::params![p.id, d.url])?;
        // Verify the site answers.
        let check = ctx.core.http.get(&d.url).timeout(std::time::Duration::from_secs(15)).send().await.map(|r| r.status().as_u16());
        let verified = matches!(check, Ok(200..=399));
        Ok(ToolOutput {
            text: format!(
                "Deployed {files} files. Live at {}. {}",
                d.url,
                if verified {
                    "Verified: the site responds."
                } else {
                    "The deploy finished but the site did not respond yet; it may take a moment."
                }
            ),
            summary: format!("Deployed to {}", d.url),
            data: Some(json!({"url": d.url, "verified": verified})),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Origin, Registry};
    use crate::core::testing::{core_with, FakePlatform};
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn publishes_a_project_to_github_and_deploys_to_netlify() {
        let server = MockServer::start().await;
        let platform = Arc::new(FakePlatform::default());
        *platform.confirm.lock() = true;
        let (core, dir) = core_with(platform);
        let bare = dir.path().join("remote.git");
        git2::Repository::init_bare(&bare).unwrap();
        Mock::given(method("POST")).and(path("/gh/user/repos")).and(header("authorization", "Bearer ghp_test"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"full_name": "keder/bakery", "html_url": "https://github.com/keder/bakery", "clone_url": format!("file://{}", bare.display())})))
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/nf/sites"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"id": "site1", "ssl_url": "https://bakery.netlify.app"})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/nf/sites/site1/deploys"))
            .and(header("content-type", "application/zip"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "d1", "state": "uploaded"})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/nf/deploys/d1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"id": "d1", "state": "ready", "ssl_url": format!("{}/live", server.uri())})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/live"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<h1>hi</h1>"))
            .mount(&server)
            .await;
        *core.api_bases.lock() = crate::integrations::ApiBases {
            github: format!("{}/gh", server.uri()),
            netlify: format!("{}/nf", server.uri()),
            brave: server.uri(),
        };
        core.secrets.set("github_token", "ghp_test").unwrap();
        core.secrets.set("netlify_token", "nf_test").unwrap();

        let (ctx, _) = ctx(core.clone(), Origin::User);
        let p = crate::tools::projects::create(&core, "Bakery", "website", Some(&ctx.conversation_id)).unwrap();
        std::fs::write(std::path::Path::new(&p.path).join("index.html"), "<h1>Bakery</h1>").unwrap();
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();

        let gh = execute(
            &r,
            &ctx,
            &json!({"type": "tool_use", "id": "g", "name": "publish_to_github", "input": {"repo_name": "bakery"}}),
            &names,
        )
        .await;
        assert!(gh.ok, "{}", gh.block);
        let remote = git2::Repository::open_bare(&bare).unwrap();
        assert!(remote.head().is_ok() || remote.branches(None).unwrap().count() > 0, "pushed to the remote");
        let commit = remote
            .find_reference("refs/heads/master")
            .or_else(|_| remote.find_reference("refs/heads/main"))
            .unwrap()
            .peel_to_commit()
            .unwrap();
        assert!(commit.tree().unwrap().get_name("index.html").is_some());

        let nf = execute(
            &r,
            &ctx,
            &json!({"type": "tool_use", "id": "n", "name": "deploy_to_netlify", "input": {"site_name": "bakery"}}),
            &names,
        )
        .await;
        assert!(nf.ok, "{}", nf.block);
        assert!(nf.block.to_string().contains("Verified"));
        let site: Option<String> =
            core.db.conn().query_row("SELECT netlify_site_id FROM projects WHERE id = ?1", [&p.id], |r| r.get(0)).unwrap();
        assert_eq!(site.as_deref(), Some("site1"));
    }

    #[tokio::test]
    async fn bad_tokens_give_a_clear_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({"message": "Bad credentials"})))
            .mount(&server)
            .await;
        let e = crate::integrations::github::whoami(&reqwest::Client::new(), &server.uri(), "bad").await.unwrap_err();
        assert!(e.to_string().contains("rejected the token"));
    }
}
