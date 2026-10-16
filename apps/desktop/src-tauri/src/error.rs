//! One error type for the core, and the serializable shape commands return to the webview.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum LumoError {
    #[error("{0} was not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    /// A permission or policy check failed. The message says what is missing.
    #[error("{0}")]
    Denied(String),
    /// A capability that is not configured or not available on this system.
    #[error("{0}")]
    Unavailable(String),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Provider(String),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl LumoError {
    pub fn code(&self) -> &'static str {
        match self {
            LumoError::NotFound(_) => "not_found",
            LumoError::Invalid(_) | LumoError::Json(_) => "invalid",
            LumoError::Denied(_) => "denied",
            LumoError::Unavailable(_) => "unavailable",
            LumoError::Cancelled => "cancelled",
            LumoError::Provider(_) => "provider",
            LumoError::Io(_) => "io",
            LumoError::Db(_) => "database",
            LumoError::Http(_) => "network",
            LumoError::Other(_) => "internal",
        }
    }
}

pub type Result<T> = std::result::Result<T, LumoError>;

/// What a command returns on failure. Never contains secrets.
#[derive(Debug, Serialize, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl From<LumoError> for ApiError {
    fn from(e: LumoError) -> Self {
        if matches!(e, LumoError::Db(_) | LumoError::Other(_)) {
            log::error!("{e:?}");
        }
        ApiError { code: e.code().into(), message: e.to_string() }
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

pub fn invalid(msg: impl Into<String>) -> LumoError {
    LumoError::Invalid(msg.into())
}
pub fn denied(msg: impl Into<String>) -> LumoError {
    LumoError::Denied(msg.into())
}
