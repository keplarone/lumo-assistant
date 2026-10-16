use chrono::{SecondsFormat, Utc};

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Move a file or folder to the system Trash, so the user can get it back.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn move_to_trash(path: &std::path::Path) -> std::result::Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// Phones have no Trash, so `move_to_trash` is never offered there. Undoing a file Lumo created
/// removes that one file; anything else is refused rather than deleted for good.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn move_to_trash(path: &std::path::Path) -> std::result::Result<(), String> {
    if path.is_file() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Err("this device has no Trash".into())
    }
}

/// Truncate text to at most `max` characters on a char boundary, marking the cut.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n… [truncated]");
    out
}

/// A short, single-line preview for logs and UI summaries.
pub fn preview(s: &str, max: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        one
    } else {
        let mut t: String = one.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}
