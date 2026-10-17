-- Orders the user confirmed with start_order, for "order again" quick chips (see src/integrations/apps.rs).
-- items_json is [{"name": ..., "quantity": ...}]. Only what the user confirmed; nothing about payment.
CREATE TABLE recent_orders (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  store TEXT,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX recent_orders_created ON recent_orders(created_at);
