-- Invoices that arrived before their vendor was approved (the held bill that led to approving
-- it) are linked to that vendor, as the core now does when a vendor is created. Only invoices
-- with the same name that asked to be paid at the vendor's exact email.
UPDATE invoices i
SET vendor_id = v.id
FROM vendors v
WHERE i.vendor_id IS NULL
  AND lower(trim(i.vendor_name)) = lower(trim(v.name))
  AND lower(trim(i.payout_email)) = v.paypal_email;
