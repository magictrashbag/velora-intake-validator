-- Hardening from adversarial review.

-- 1. accounts: identity columns are immutable, and balance can ONLY change through ledger
--    entries. ledger_apply_entry raises a transaction-local flag; any other UPDATE of balance
--    is rejected. (A superuser can still bypass any trigger. Production uses an app role
--    without DDL/superuser rights, and daily reconciliation re-derives balances from entries.)
CREATE OR REPLACE FUNCTION ledger_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('puente.ledger_apply', 'on', true);
  UPDATE accounts SET balance = balance + NEW.amount
   WHERE id = NEW.account_id AND currency = NEW.currency;
  PERFORM set_config('puente.ledger_apply', 'off', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger: account % has no currency %', NEW.account_id, NEW.currency;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.currency <> OLD.currency
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'accounts: id/kind/currency/owner are immutable';
  END IF;
  IF NEW.balance <> OLD.balance AND coalesce(current_setting('puente.ledger_apply', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'accounts: balance can only change via ledger entries';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_guard BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- 2. Ledger transaction kinds are a closed set.
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN
  ('p2p','deposit','payout','fx','fee','card','adjustment','crypto_withdrawal','hold','hold_release'));

-- 3. Stronger routing invariant. Per-transaction checks alone can be dodged by splitting a
--    conversion into two single-currency postings. Currency only changes hands through the
--    fx_inventory accounts, so:
--      * any transaction touching fx_inventory must be kind 'fx';
--      * every 'fx' transaction must be exactly two currencies, one of them USDC;
--      * every OTHER transaction must be single-currency (no conversions outside 'fx').
CREATE OR REPLACE FUNCTION ledger_check_routed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; has_hub boolean; touches_fx boolean; k text;
BEGIN
  SELECT count(DISTINCT e.currency), coalesce(bool_or(e.currency = 'USDC'), false), coalesce(bool_or(a.kind = 'fx_inventory'), false)
    INTO n, has_hub, touches_fx
    FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = NEW.txn_id;
  SELECT kind INTO k FROM ledger_transactions WHERE id = NEW.txn_id;
  IF k = 'fx' THEN
    IF n <> 2 OR NOT has_hub THEN
      RAISE EXCEPTION 'ledger: transaction % converts without routing through USDC', NEW.txn_id;
    END IF;
  ELSE
    IF touches_fx THEN
      RAISE EXCEPTION 'ledger: transaction % touches fx_inventory but is not an fx transaction', NEW.txn_id;
    END IF;
    IF n > 1 THEN
      RAISE EXCEPTION 'ledger: transaction % converts without routing through USDC (multi-currency non-fx)', NEW.txn_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- 4. Held transfers reserve their funds in compliance_hold (per currency).
INSERT INTO accounts (kind, currency) VALUES ('compliance_hold','VES');
ALTER TABLE transfers ADD COLUMN hold_ledger_txn_id uuid REFERENCES ledger_transactions(id);
ALTER TABLE transfers ADD CONSTRAINT transfers_hold_reserved
  CHECK ((status = 'held_for_review') = (hold_ledger_txn_id IS NOT NULL));

-- 5. Deposits: one on-chain transaction can carry several transfers (batches, multiple logs).
--    Idempotency key is (network, tx_hash, log_index); hashes are stored normalised.
ALTER TABLE crypto_deposits ADD COLUMN log_index integer NOT NULL DEFAULT 0 CHECK (log_index >= 0);
ALTER TABLE crypto_deposits DROP CONSTRAINT crypto_deposits_network_tx_hash_key;
ALTER TABLE crypto_deposits ADD CONSTRAINT crypto_deposits_event_key UNIQUE (network, tx_hash, log_index);
ALTER TABLE crypto_deposits ADD CONSTRAINT crypto_deposits_hash_normalised
  CHECK (network = 'solana' OR tx_hash = lower(tx_hash));
