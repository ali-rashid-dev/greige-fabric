UPDATE invoices
SET returned_minor = COALESCE((
  SELECT SUM(r.receivable_minor)
  FROM sales_returns r
  WHERE r.invoice_id = invoices.id AND r.reversed_at IS NULL
), 0);
