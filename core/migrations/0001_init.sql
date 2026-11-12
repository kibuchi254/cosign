-- Cosign core schema. The Rust core owns this database; no other service writes to it.

CREATE TABLE vendors (
    id           uuid PRIMARY KEY,
    name         text NOT NULL,
    paypal_email text NOT NULL,
    -- sha256 of the lower-cased payout email; PAYOUT_DETAILS_CHANGED compares against it.
    payout_hash  text NOT NULL,
    verified_at  timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_key ON vendors (lower(name));

CREATE TABLE mandates (
    id         uuid PRIMARY KEY,
    owner_id   text NOT NULL,
    rules_json jsonb NOT NULL,
    hash       text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The newest mandate for an owner is the active one; older rows stay for the audit trail.
CREATE INDEX mandates_owner_created ON mandates (owner_id, created_at DESC);

CREATE TABLE invoices (
    id             uuid PRIMARY KEY,
    vendor_id      uuid REFERENCES vendors (id),
    vendor_name    text NOT NULL,
    number         text NOT NULL,
    amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
    currency       char(3) NOT NULL,
    due_date       date,
    payout_email   text NOT NULL,
    -- Ties the row to the exact document the agent read.
    source_hash    text NOT NULL,
    extracted_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    flags          jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_vendor ON invoices (vendor_id);
CREATE INDEX invoices_created ON invoices (created_at);

CREATE TABLE payments (
    id                uuid PRIMARY KEY,
    invoice_id        uuid NOT NULL REFERENCES invoices (id),
    mandate_id        uuid NOT NULL REFERENCES mandates (id),
    amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
    currency          char(3) NOT NULL,
    receiver_email    text NOT NULL,
    decision          text NOT NULL CHECK (decision IN ('ALLOW', 'REQUIRE_APPROVAL', 'BLOCK')),
    reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
    decision_hash     text NOT NULL,
    state             text NOT NULL,
    paypal_payout_ref text,
    paypal_item_id    text,
    failure           text,
    -- Sent as PayPal-Request-Id on every money call, so a retry cannot pay twice.
    idempotency_key   uuid NOT NULL UNIQUE,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_state ON payments (state);
CREATE INDEX payments_created ON payments (created_at);

CREATE TABLE approvals (
    id            uuid PRIMARY KEY,
    -- The payment (or later, milestone) the approval is for.
    subject_id    uuid NOT NULL,
    -- The hash of the decision being approved; must equal payments.decision_hash.
    decision_hash text NOT NULL,
    approver      text NOT NULL,
    verdict       text NOT NULL CHECK (verdict IN ('approve', 'deny')),
    note          text,
    decided_at    timestamptz NOT NULL DEFAULT now()
);
-- One verdict per decision.
CREATE UNIQUE INDEX approvals_subject_decision ON approvals (subject_id, decision_hash);

CREATE TABLE deals (
    id         uuid PRIMARY KEY,
    title      text NOT NULL,
    buyer      text NOT NULL,
    seller     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE milestones (
    id               uuid PRIMARY KEY,
    deal_id          uuid NOT NULL REFERENCES deals (id),
    title            text NOT NULL,
    amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
    currency         char(3) NOT NULL,
    criteria_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
    state            text NOT NULL DEFAULT 'DRAFT',
    paypal_order_id  text,
    authorization_id text,
    auth_expires_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
-- Drives the day-3 re-authorization job.
CREATE INDEX milestones_auth_expiry ON milestones (auth_expires_at) WHERE authorization_id IS NOT NULL;

CREATE TABLE webhook_events (
    event_id     text PRIMARY KEY,
    event_type   text NOT NULL,
    verified     boolean NOT NULL,
    payload_json jsonb NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    seq          bigint PRIMARY KEY,
    ts           timestamptz NOT NULL,
    kind         text NOT NULL,
    payload_json jsonb NOT NULL,
    prev_hash    text NOT NULL,
    hash         text NOT NULL UNIQUE
);

-- Append-only: the application role can insert but never rewrite history.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
