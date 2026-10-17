-- Everyday helpers (src/everyday): plain-word reminders, bills and subscriptions, price watches and
-- the morning brief. None of these call a model in the background, so they cost nothing to run.

-- due_at is the next time it fires (UTC, RFC 3339). repeat: none | daily | weekdays | weekly | monthly.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  done INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX reminders_by_due ON reminders(done, due_at);

-- next_renewal is a local date (YYYY-MM-DD). warned_for is the renewal date already warned about.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  cycle TEXT NOT NULL,
  next_renewal TEXT NOT NULL,
  manage_url TEXT,
  warned_for TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE price_watches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  currency TEXT,
  target_price REAL,
  first_price REAL,
  last_price REAL,
  lowest_price REAL,
  last_checked_at TEXT,
  next_check_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);

-- One brief per local day (YYYY-MM-DD).
CREATE TABLE briefs (
  day TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
