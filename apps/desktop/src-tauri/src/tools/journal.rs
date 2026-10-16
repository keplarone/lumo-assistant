//! A journal of file changes Lumo made, so a run's changes can be reviewed and undone.

use super::ToolCtx;
use crate::core::Core;
use crate::error::Result;
use crate::util::{new_id, now};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Largest file Lumo will back up before overwriting. Bigger files are not overwritten at all.
pub const MAX_BACKUP_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub run_id: Option<String>,
    pub op: String,
    pub path: String,
    pub dest_path: Option<String>,
    pub backup_path: Option<String>,
    pub created_at: String,
    pub undone: bool,
}

pub fn record(ctx: &ToolCtx, op: &str, path: &Path, dest: Option<&Path>, backup: Option<&Path>) -> Result<()> {
    ctx.core.db.conn().execute(
        "INSERT INTO file_journal(id, run_id, tool_call_id, op, path, dest_path, backup_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            new_id(),
            ctx.run_id,
            ctx.call_id,
            op,
            path.display().to_string(),
            dest.map(|d| d.display().to_string()),
            backup.map(|b| b.display().to_string()),
            now()
        ],
    )?;
    Ok(())
}

/// Copy a file into Lumo's backup folder before it is changed.
pub fn backup(core: &Core, path: &Path) -> Result<PathBuf> {
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let dest = core.paths.backups_dir.join(format!("{}-{}", new_id(), name));
    std::fs::create_dir_all(&core.paths.backups_dir)?;
    std::fs::copy(path, &dest)?;
    Ok(dest)
}

pub fn list(core: &Core, run_id: Option<&str>, limit: u32) -> Result<Vec<JournalEntry>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(
        "SELECT id, run_id, op, path, dest_path, backup_path, created_at, undone FROM file_journal WHERE (?1 IS NULL OR run_id = ?1) ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = st
        .query_map(rusqlite::params![run_id, limit], |r| {
            Ok(JournalEntry {
                id: r.get(0)?,
                run_id: r.get(1)?,
                op: r.get(2)?,
                path: r.get(3)?,
                dest_path: r.get(4)?,
                backup_path: r.get(5)?,
                created_at: r.get(6)?,
                undone: r.get::<_, i64>(7)? != 0,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub undone: usize,
    /// Changes that could not be reversed safely, with the reason.
    pub skipped: Vec<String>,
}

/// Reverse a run's file changes, newest first. Never overwrites anything that changed since.
pub fn undo_run(core: &Core, run_id: &str) -> Result<UndoReport> {
    let entries: Vec<JournalEntry> = list(core, Some(run_id), 10_000)?.into_iter().filter(|e| !e.undone).collect();
    let mut report = UndoReport::default();
    for e in entries {
        let path = PathBuf::from(&e.path);
        let outcome: std::result::Result<(), String> = match e.op.as_str() {
            "create_file" => {
                if path.exists() {
                    crate::util::move_to_trash(&path).map_err(|err| format!("{}: could not move to Trash ({err})", e.path))
                } else {
                    Ok(())
                }
            }
            "overwrite_file" => match &e.backup_path {
                Some(b) if Path::new(b).exists() => std::fs::copy(b, &path).map(|_| ()).map_err(|err| format!("{}: {err}", e.path)),
                _ => Err(format!("{}: the backup is missing", e.path)),
            },
            "create_folder" => {
                if path.is_dir() {
                    std::fs::remove_dir(&path).map_err(|_| format!("{}: the folder is no longer empty, so it was kept", e.path))
                } else {
                    Ok(())
                }
            }
            "move" => {
                let dest = PathBuf::from(e.dest_path.clone().unwrap_or_default());
                if path.exists() {
                    Err(format!("{}: something new is at the original location", e.path))
                } else if !dest.exists() {
                    Err(format!("{}: the moved item is gone", dest.display()))
                } else {
                    std::fs::rename(&dest, &path).map_err(|err| format!("{}: {err}", e.path))
                }
            }
            "trash" => Err(format!("{}: restore it from the system Trash", e.path)),
            other => Err(format!("{}: cannot undo '{other}'", e.path)),
        };
        match outcome {
            Ok(()) => {
                core.db.conn().execute("UPDATE file_journal SET undone = 1 WHERE id = ?1", [&e.id])?;
                report.undone += 1;
            }
            Err(msg) => report.skipped.push(msg),
        }
    }
    crate::audit::record(
        &core.db,
        "user",
        "undo_run",
        Some(run_id),
        Some(&serde_json::json!({"undone": report.undone, "skipped": report.skipped.len()})),
        "ok",
    );
    Ok(report)
}
