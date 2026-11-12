-- Fixes from the second adversarial review.

-- Limits must count a transfer when its money MOVES, not when it was requested: a transfer held
-- for days and approved today counts against today's limit.
ALTER TABLE transfers ADD COLUMN executed_at timestamptz;
UPDATE transfers SET executed_at = created_at WHERE status = 'posted';
ALTER TABLE transfers ADD CONSTRAINT transfers_executed_at CHECK ((status = 'posted') = (executed_at IS NOT NULL));
CREATE INDEX ON transfers (sender_user_id, executed_at);

-- New reasons merged into a live case invalidate approvals given before them.
ALTER TABLE review_cases ADD COLUMN reasons_updated_at timestamptz NOT NULL DEFAULT now();

-- Re-screening bookkeeping: attempts are tracked separately from successful results so that
-- persistently 'pending' users cannot starve everyone else.
ALTER TABLE users ADD COLUMN screening_attempted_at timestamptz;

-- OFAC reports can also cover a customer's WALLET balance (blocked when the customer becomes a
-- confirmed sanctions match), not only a single transfer or deposit.
ALTER TABLE ofac_reports ADD COLUMN account_id uuid REFERENCES accounts(id);
ALTER TABLE ofac_reports DROP CONSTRAINT ofac_reports_check;
ALTER TABLE ofac_reports ADD CONSTRAINT ofac_reports_one_subject CHECK (num_nonnulls(transfer_id, deposit_id, account_id) = 1);
