-- Model usage per calendar month (local time) for plan limits (see src/plans.rs).
-- month is 'YYYY-MM'; tokens is input + output tokens of every model call made in that month.
CREATE TABLE usage_monthly (
  month TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
