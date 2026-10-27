ALTER TABLE invoices ADD COLUMN customer_phone TEXT;
ALTER TABLE invoices ADD COLUMN customer_address TEXT;
ALTER TABLE invoices ADD COLUMN payment_terms_days INTEGER
  CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0);

UPDATE invoices
SET customer_phone = (SELECT phone FROM customers WHERE customers.id = invoices.customer_id),
    customer_address = (SELECT address FROM customers WHERE customers.id = invoices.customer_id),
    payment_terms_days = (
      SELECT payment_terms_days FROM customers WHERE customers.id = invoices.customer_id
    )
WHERE customer_id IS NOT NULL;
