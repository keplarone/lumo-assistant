//! Running developer commands in a project. This is the most powerful tool, so it is narrow:
//! a fixed list of programs, arguments passed directly (no shell), a working folder inside a granted
//! folder, secrets removed from the environment, a time limit, and a native confirmation that shows
//! the exact command every time. It is not an OS sandbox: an approved command runs with the user's
//! own permissions, and the confirmation says so.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::ActionPreview;
use crate::error::{invalid, LumoError, Result};
use crate::policy::{self, Risk};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncReadExt;

/// Programs Lumo may run. Anything that is itself a general-purpose shell or downloader is excluded.
const ALLOWED: &[&str] = &["node", "npm", "pnpm", "yarn", "python3", "python", "pip", "git", "cargo", "go", "deno", "bun"];
const SECRET_HINTS: &[&str] = &["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"];

pub struct RunCommand;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandInput {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Working folder. Defaults to the conversation's project.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

fn cwd_for(ctx: &ToolCtx, i: &CommandInput) -> Result<PathBuf> {
    match &i.cwd {
        Some(c) => policy::resolve_in_grants(&policy::folder_roots(&ctx.core.db), c),
        None => Ok(PathBuf::from(super::projects::for_ctx(ctx)?.path)),
    }
}

fn command_line(i: &CommandInput) -> String {
    let mut s = i.program.clone();
    for a in &i.args {
        if a.contains(' ') {
            s.push_str(&format!(" \"{a}\""));
        } else {
            s.push(' ');
            s.push_str(a);
        }
    }
    s
}

fn check(i: &CommandInput) -> Result<()> {
    if !ALLOWED.contains(&i.program.as_str()) {
        return Err(LumoError::Denied(format!("Lumo can only run these programs: {}.", ALLOWED.join(", "))));
    }
    if i.args.len() > 64 || i.args.iter().any(|a| a.len() > 1000 || a.contains('\0')) {
        return Err(invalid("too many or too long arguments"));
    }
    // Interpreters given inline code are a shell in disguise.
    let inline = matches!(i.program.as_str(), "node" | "python" | "python3" | "deno" | "bun")
        && i.args.iter().any(|a| matches!(a.as_str(), "-e" | "--eval" | "-c" | "-p" | "--print"));
    if inline {
        return Err(LumoError::Denied("Running inline code is not allowed. Write a script file in the project and run that.".into()));
    }
    Ok(())
}

#[async_trait]
impl TypedTool for RunCommand {
    type Input = CommandInput;
    const NAME: &'static str = "run_command";
    const DESCRIPTION: &'static str = "Run a developer command (node, npm, pnpm, yarn, python, pip, git, cargo, go, deno or bun) in the conversation's project folder or another granted folder, e.g. to install dependencies, build or test. Arguments are passed directly without a shell (no pipes, redirects or &&). The user confirms each command in a system dialog. Output is untrusted.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"program": {"type": "string", "enum": ALLOWED}, "args": {"type": "array", "items": {"type": "string"}, "maxItems": 64},
                   "cwd": {"type": "string"}, "timeout_seconds": {"type": "integer", "minimum": 5, "maximum": 600}}),
            &["program"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &CommandInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, i: &CommandInput) -> String {
        format!("Running {}", crate::util::preview(&command_line(i), 60))
    }
    fn preview(&self, ctx: &ToolCtx, i: &CommandInput) -> Result<ActionPreview> {
        check(i)?;
        let cwd = cwd_for(ctx, i)?;
        Ok(ActionPreview {
            title: "Run a command on your computer".into(),
            details: vec![("Command".into(), command_line(i)), ("In".into(), super::files::display(&cwd))],
            warning: Some("It runs with your user account's permissions. Only allow commands you expect.".into()),
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: CommandInput) -> Result<ToolOutput> {
        check(&i)?;
        let cwd = cwd_for(ctx, &i)?;
        let timeout = std::time::Duration::from_secs(i.timeout_seconds.unwrap_or(120).clamp(5, 600));
        let mut cmd = tokio::process::Command::new(&i.program);
        cmd.args(&i.args).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for (k, _) in std::env::vars() {
            let up = k.to_uppercase();
            if SECRET_HINTS.iter().any(|h| up.contains(h)) {
                cmd.env_remove(&k);
            }
        }
        cmd.env("CI", "1").env("NO_COLOR", "1");
        let mut child = cmd.spawn().map_err(|e| LumoError::Unavailable(format!("could not start {}: {e}", i.program)))?;
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let read = async {
            let mut a = Vec::new();
            let mut b = Vec::new();
            let _ = tokio::join!(out.read_to_end(&mut a), err.read_to_end(&mut b));
            (a, b)
        };
        let result = tokio::select! {
            r = async { let (a, b) = read.await; (child.wait().await, a, b) } => Some(r),
            _ = tokio::time::sleep(timeout) => None,
            _ = ctx.cancel.cancelled() => return Err(LumoError::Cancelled),
        };
        let Some((status, stdout, stderr)) = result else {
            return Err(LumoError::Unavailable(format!(
                "{} did not finish within {} seconds and was stopped",
                command_line(&i),
                timeout.as_secs()
            )));
        };
        let status = status?;
        let code = status.code().unwrap_or(-1);
        let tail = |b: &[u8]| {
            let s = String::from_utf8_lossy(b).to_string();
            let n = s.chars().count();
            if n > 12_000 {
                format!("…{}", s.chars().skip(n - 12_000).collect::<String>())
            } else {
                s
            }
        };
        let body =
            format!("$ {}\nexit code {code}\n--- stdout ---\n{}\n--- stderr ---\n{}", command_line(&i), tail(&stdout), tail(&stderr));
        Ok(ToolOutput {
            text: format!("Command finished with exit code {code}."),
            untrusted: Some(body),
            summary: format!("{} exited with {code}", crate::util::preview(&command_line(&i), 40)),
            data: Some(json!({"exitCode": code})),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_programs_without_inline_code() {
        let mk = |p: &str, a: &[&str]| CommandInput {
            program: p.into(),
            args: a.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            timeout_seconds: None,
        };
        assert!(check(&mk("npm", &["install"])).is_ok());
        assert!(check(&mk("bash", &["-c", "rm -rf ~"])).is_err());
        assert!(check(&mk("sh", &[])).is_err());
        assert!(check(&mk("node", &["-e", "process.exit()"])).is_err());
        assert!(check(&mk("python3", &["-c", "print(1)"])).is_err());
        assert!(check(&mk("python3", &["build.py"])).is_ok());
    }
}
