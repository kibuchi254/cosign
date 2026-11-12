-- Milestone escrow: a buyer funds each milestone with a PayPal authorization, the seller
-- delivers, the agent checks the evidence against the criteria, the buyer releases.

ALTER TABLE deals
    ADD COLUMN owner_id     text NOT NULL DEFAULT 'demo',
    ADD COLUMN seller_email text NOT NULL DEFAULT '';

ALTER TABLE milestones
    ADD COLUMN seq                     int NOT NULL DEFAULT 1,
    ADD COLUMN approve_url             text,
    ADD COLUMN authorized_at           timestamptz,
    ADD COLUMN reauthorized_count      int NOT NULL DEFAULT 0,
    ADD COLUMN evidence_json           jsonb,
    ADD COLUMN evidence_hash           text,
    ADD COLUMN criteria_result_json    jsonb,
    -- Set when the criteria check failed or flagged something; the buyer must decide.
    ADD COLUMN hold_reasons            jsonb,
    -- The buyer looked at the hold and accepted the work anyway.
    ADD COLUMN buyer_accepted_hold     boolean NOT NULL DEFAULT false,
    ADD COLUMN capture_id              text,
    ADD COLUMN payout_ref              text,
    ADD COLUMN failure                 text,
    -- PayPal-Request-Id for the capture and the payout on release.
    ADD COLUMN release_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN updated_at              timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX milestones_deal_seq ON milestones (deal_id, seq);
