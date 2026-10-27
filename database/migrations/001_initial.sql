CREATE TABLE fabrics (
  id TEXT PRIMARY KEY NOT NULL,
  sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  construction TEXT NOT NULL,
  composition TEXT NOT NULL,
  width_inches REAL NOT NULL,
  gsm REAL NOT NULL,
  purchase_cost_minor INTEGER NOT NULL,
  selling_rate_minor INTEGER NOT NULL,
  reorder_threshold_mm INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX fabrics_name_idx ON fabrics(name);
CREATE INDEX fabrics_active_idx ON fabrics(active);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY NOT NULL,
  fabric_id TEXT NOT NULL REFERENCES fabrics(id) ON DELETE RESTRICT,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm <> 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX stock_movements_fabric_idx ON stock_movements(fabric_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_number TEXT NOT NULL UNIQUE,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  fabric_id TEXT NOT NULL REFERENCES fabrics(id) ON DELETE RESTRICT,
  sku_snapshot TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0)
);

CREATE INDEX invoice_items_fabric_idx ON invoice_items(fabric_id);
