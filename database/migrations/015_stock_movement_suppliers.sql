ALTER TABLE stock_movements ADD COLUMN supplier_id TEXT
  REFERENCES suppliers(id) ON DELETE RESTRICT;

CREATE INDEX stock_movements_supplier_idx ON stock_movements(supplier_id);
