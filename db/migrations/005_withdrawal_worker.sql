-- Withdrawal outbox lifecycle:
--   queued -> sending (claimed by a worker) -> broadcast (custodian accepted) -> confirmed | failed
-- A 'sending' row whose claim is stale is re-sent with the SAME idempotency key (transfer_id),
-- so a worker crash can't lose or duplicate an on-chain send. We NEVER refund on our own errors
-- (a timeout may still have sent the funds): only a custodian-reported failure refunds.
ALTER TABLE crypto_withdrawals DROP CONSTRAINT crypto_withdrawals_status_check;
ALTER TABLE crypto_withdrawals ADD CONSTRAINT crypto_withdrawals_status_check
  CHECK (status IN ('queued','sending','broadcast','confirmed','failed'));
ALTER TABLE crypto_withdrawals
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN last_error text,
  ADD COLUMN needs_attention boolean NOT NULL DEFAULT false,
  ADD COLUMN chain_tx_hash text,
  ADD COLUMN resolved_ledger_txn_id uuid REFERENCES ledger_transactions(id),
  ADD COLUMN resolved_at timestamptz,
  ADD CONSTRAINT crypto_withdrawals_resolved CHECK ((status IN ('confirmed','failed')) = (resolved_ledger_txn_id IS NOT NULL));
CREATE INDEX ON crypto_withdrawals (status, created_at);
