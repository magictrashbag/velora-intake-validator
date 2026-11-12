-- Puente initial schema.
-- Design rules enforced HERE (not just in app code), so a bug or a bad manual query
-- cannot corrupt money:
--   1. Double-entry: every ledger transaction's entries sum to zero per currency (checked at COMMIT).
--   2. Append-only: ledger, compliance decisions and audit log reject UPDATE/DELETE/TRUNCATE.
--   3. No overdraft: user wallet balances can never go negative.
--   4. Idempotency: a client retry with the same key can never move money twice.
--   5. No secrets at rest in plaintext: session tokens and OTP codes are stored hashed.

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  kyc_tier     smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 2),
  screening    text NOT NULL DEFAULT 'pending'
               CHECK (screening IN ('clear','pending','potential_match','confirmed_match')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  code_hash    bytea NOT NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenges (phone, created_at DESC);

CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Accounts: user wallets plus system accounts (owner NULL) that represent the other side of
-- every external flow: custody float, payout clearing, FX inventory, fee revenue.
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('user_wallet','custody_float','payout_clearing','fx_inventory','fee_revenue')),
  currency       text NOT NULL CHECK (currency IN ('USDC','VES','USD')),
  balance        bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'user_wallet') = (owner_user_id IS NOT NULL)),
  CHECK (kind <> 'user_wallet' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_user_currency ON accounts (owner_user_id, currency) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_kind_currency ON accounts (kind, currency) WHERE owner_user_id IS NULL;

CREATE TABLE ledger_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,  -- p2p | deposit | payout | fx | fee | card | adjustment
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          bigserial PRIMARY KEY,
  txn_id      uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  currency    text NOT NULL,
  amount      bigint NOT NULL CHECK (amount <> 0),   -- signed minor units: + credit, - debit
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id, id);
CREATE INDEX ON ledger_entries (txn_id);

-- Keep the cached balance in lock-step with entries. The row UPDATE also serialises
-- concurrent postings to the same account, and the CHECK on accounts blocks overdraft.
CREATE FUNCTION ledger_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount
   WHERE id = NEW.account_id AND currency = NEW.currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger: account % has no currency %', NEW.account_id, NEW.currency;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

-- Double-entry check, deferred to COMMIT so a transaction can insert its legs in any order.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(amount) AS total INTO bad
    FROM ledger_entries WHERE txn_id = NEW.txn_id
   GROUP BY currency HAVING sum(amount) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger: transaction % unbalanced in % by %', NEW.txn_id, bad.currency, bad.total;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- Transfers: the business object a user initiated. Holds the idempotency key, the
-- compliance outcome, and (if posted) the ledger transaction that moved the money.
CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id   uuid NOT NULL REFERENCES users(id),
  recipient_user_id uuid REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('p2p','payout_bank','fx','card_spend','remittance_in')),
  currency         text NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  amount_usd_cents bigint NOT NULL CHECK (amount_usd_cents >= 0),
  status           text NOT NULL CHECK (status IN ('posted','held_for_review','denied')),
  ledger_txn_id    uuid REFERENCES ledger_transactions(id),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash     bytea NOT NULL,   -- same key + different body => reject, never guess
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_user_id, idempotency_key),
  CHECK ((status = 'posted') = (ledger_txn_id IS NOT NULL))
);
CREATE INDEX ON transfers (sender_user_id, created_at);

CREATE TABLE fx_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  sell_currency text NOT NULL,
  buy_currency  text NOT NULL,
  sell_minor    bigint NOT NULL CHECK (sell_minor > 0),
  buy_minor     bigint NOT NULL CHECK (buy_minor > 0),
  mid_rate      text NOT NULL,
  spread_bps    integer NOT NULL,
  rate_source   text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every compliance-gate evaluation, including allows, with the exact inputs. Regulators ask
-- "why was this allowed?" as often as "why was this blocked?".
CREATE TABLE compliance_decisions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  transfer_id uuid REFERENCES transfers(id),
  outcome     text NOT NULL CHECK (outcome IN ('allow','review','deny')),
  reasons     text[] NOT NULL,
  context     jsonb NOT NULL,
  policy_version text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid,
  action         text NOT NULL,
  subject        text,
  details        jsonb NOT NULL DEFAULT '{}',
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries','compliance_decisions','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- System accounts.
INSERT INTO accounts (kind, currency) VALUES
  ('custody_float','USDC'), ('custody_float','USD'), ('custody_float','VES'),
  ('payout_clearing','VES'), ('payout_clearing','USDC'),
  ('fx_inventory','USDC'), ('fx_inventory','VES'),
  ('fee_revenue','USDC'), ('fee_revenue','VES');
