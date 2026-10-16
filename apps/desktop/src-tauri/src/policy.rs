//! Permission policy enforced at the execution boundary: folder grants, sensitive-path denylist,
//! capability grants, and rate limits. Nothing here trusts the model or the webview.

use crate::db::Db;
use crate::error::{denied, invalid, Result};
use crate::util::{new_id, now};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    /// No side effects outside the conversation (plan, questions, comparison cards).
    Ui,
    Read,
    Write,
    Sensitive,
}

impl Risk {
    pub fn as_str(&self) -> &'static str {
        match self {
            Risk::Ui => "ui",
            Risk::Read => "read",
            Risk::Write => "write",
            Risk::Sensitive => "sensitive",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub label: String,
    pub created_at: String,
}

pub const CAPABILITIES: &[(&str, &str)] = &[
    ("clipboard_read", "Read your clipboard"),
    ("screen", "See your screen when you ask"),
    ("input_control", "Control mouse and keyboard when you ask"),
    ("active_window", "Know which app is in front"),
];

pub fn list_grants(db: &Db) -> Result<Vec<Grant>> {
    let conn = db.conn();
    let mut st = conn.prepare("SELECT id, kind, target, label, created_at FROM grants ORDER BY kind, label")?;
    let rows = st
        .query_map([], |r| Ok(Grant { id: r.get(0)?, kind: r.get(1)?, target: r.get(2)?, label: r.get(3)?, created_at: r.get(4)? }))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add_folder_grant(db: &Db, path: &Path) -> Result<Grant> {
    let canon = std::fs::canonicalize(path).map_err(|_| invalid(format!("{} does not exist", path.display())))?;
    if !canon.is_dir() {
        return Err(invalid("only folders can be granted"));
    }
    if is_protected(&canon) || canon.parent().is_none() {
        return Err(denied(format!("Lumo does not accept access to {} because it holds system or credential files.", canon.display())));
    }
    let label = canon.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| canon.display().to_string());
    let g = Grant { id: new_id(), kind: "folder".into(), target: canon.display().to_string(), label, created_at: now() };
    db.conn().execute(
        "INSERT INTO grants(id, kind, target, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(kind, target) DO NOTHING",
        rusqlite::params![g.id, g.kind, g.target, g.label, g.created_at],
    )?;
    Ok(g)
}

pub fn add_capability_grant(db: &Db, capability: &str) -> Result<Grant> {
    let (_, label) = CAPABILITIES.iter().find(|(c, _)| *c == capability).ok_or_else(|| invalid("unknown capability"))?;
    let g = Grant { id: new_id(), kind: "capability".into(), target: capability.into(), label: (*label).into(), created_at: now() };
    db.conn().execute(
        "INSERT INTO grants(id, kind, target, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(kind, target) DO NOTHING",
        rusqlite::params![g.id, g.kind, g.target, g.label, g.created_at],
    )?;
    Ok(g)
}

pub fn revoke(db: &Db, id: &str) -> Result<()> {
    db.conn().execute("DELETE FROM grants WHERE id = ?1", [id])?;
    Ok(())
}

pub fn has_capability(db: &Db, capability: &str) -> bool {
    db.conn()
        .query_row("SELECT 1 FROM grants WHERE kind = 'capability' AND target = ?1", [capability], |_| Ok(()))
        .is_ok()
}

pub fn folder_roots(db: &Db) -> Vec<PathBuf> {
    list_grants(db)
        .unwrap_or_default()
        .into_iter()
        .filter(|g| g.kind == "folder")
        .map(|g| PathBuf::from(g.target))
        .collect()
}

/// Folders and files inside a grant that Lumo still refuses to touch.
fn is_protected(p: &Path) -> bool {
    const NAMES: &[&str] = &[
        ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "Keychains", ".config/gcloud",
        "one.keplar.lumo", ".git/config",
    ];
    let s = p.to_string_lossy().replace('\\', "/");
    if NAMES.iter().any(|n| s.contains(&format!("/{n}"))) {
        return true;
    }
    #[cfg(unix)]
    for sys in ["/etc", "/bin", "/sbin", "/usr", "/boot", "/dev", "/proc", "/sys", "/System", "/Library", "/private/etc"] {
        if s == sys || s.starts_with(&format!("{sys}/")) {
            return true;
        }
    }
    #[cfg(windows)]
    {
        let l = s.to_ascii_lowercase();
        if l.contains("/windows/") || l.ends_with("/windows") || l.contains("/program files") || l.contains("/appdata/") {
            return true;
        }
    }
    false
}

/// Expand `~` and resolve a user/model-supplied path to a canonical path inside a granted folder.
/// For paths that do not exist yet (writes), the nearest existing ancestor is canonicalized, so a
/// symlink cannot be used to escape the grant.
pub fn resolve_in_grants(roots: &[PathBuf], raw: &str) -> Result<PathBuf> {
    if roots.is_empty() {
        return Err(denied("Lumo has no folder access yet. Grant a folder in Settings → Permissions (or when Lumo asks)."));
    }
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(invalid("path is empty"));
    }
    let expanded = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        dirs::home_dir().ok_or_else(|| invalid("no home directory"))?.join(rest)
    } else if raw == "~" {
        dirs::home_dir().ok_or_else(|| invalid("no home directory"))?
    } else {
        PathBuf::from(raw)
    };
    // Relative paths are relative to the first granted folder.
    let abs = if expanded.is_absolute() { expanded } else { roots[0].join(expanded) };
    if abs.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(invalid("paths may not contain '..'"));
    }
    // Canonicalize the longest existing prefix.
    let mut existing = abs.clone();
    let mut tail = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| invalid("invalid path"))?.to_owned();
        tail.push(name);
        if !existing.pop() {
            return Err(invalid("invalid path"));
        }
    }
    let mut canon = std::fs::canonicalize(&existing)?;
    for t in tail.into_iter().rev() {
        canon.push(t);
    }
    if is_protected(&canon) {
        return Err(denied(format!("{} is a protected location that Lumo will not access.", canon.display())));
    }
    if roots.iter().any(|r| canon.starts_with(r)) {
        Ok(canon)
    } else {
        Err(denied(format!(
            "{} is outside the folders you've granted Lumo. Grant access in Settings → Permissions.",
            canon.display()
        )))
    }
}

/// Simple sliding-window limiter per key (tool name, provider).
#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    pub fn check(&self, key: &str, max: usize, per: std::time::Duration) -> Result<()> {
        let mut map = self.hits.lock();
        let v = map.entry(key.to_string()).or_default();
        let cutoff = Instant::now() - per;
        v.retain(|t| *t > cutoff);
        if v.len() >= max {
            return Err(denied(format!("Rate limit reached for {key}; try again in a moment.")));
        }
        v.push(Instant::now());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_must_stay_inside_grants() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("granted");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let roots = vec![root.clone()];
        assert_eq!(resolve_in_grants(&roots, root.join("sub").to_str().unwrap()).unwrap(), root.join("sub"));
        assert_eq!(resolve_in_grants(&roots, "sub/new.txt").unwrap(), root.join("sub/new.txt"));
        assert!(resolve_in_grants(&roots, "../outside.txt").is_err());
        assert!(resolve_in_grants(&roots, dir.path().to_str().unwrap()).is_err());
        assert!(resolve_in_grants(&[], "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_a_grant() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let root = base.join("granted");
        let outside = base.join("secret");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let roots = vec![root];
        assert!(resolve_in_grants(&roots, "link/file.txt").is_err());
    }

    #[test]
    fn protected_paths_are_refused_even_inside_a_grant() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        assert!(resolve_in_grants(&[root.clone()], ".ssh/id_ed25519").is_err());
    }

    #[test]
    fn rate_limiter_blocks_bursts() {
        let r = RateLimiter::default();
        for _ in 0..3 {
            r.check("t", 3, std::time::Duration::from_secs(60)).unwrap();
        }
        assert!(r.check("t", 3, std::time::Duration::from_secs(60)).is_err());
    }
}
