-- Crypto-routed conversions and crypto-specific compliance controls.

-- 1. ROUTING INVARIANT: every conversion settles through USDC (the crypto settlement asset).
--    A ledger transaction may touch one currency, or exactly two where one is USDC.
--    USD<->VES (fiat<->fiat) or 3-currency "netted" postings are rejected at COMMIT.
CREATE FUNCTION ledger_check_routed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; has_hub boolean;
BEGIN
  SELECT count(DISTINCT currency), coalesce(bool_or(currency = 'USDC'), false)
    INTO n, has_hub FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF n > 2 OR (n = 2 AND NOT has_hub) THEN
    RAISE EXCEPTION 'ledger: transaction % converts without routing through USDC', NEW.txn_id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_routed AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_routed();

ALTER TABLE fx_quotes
  ADD CONSTRAINT fx_quotes_routed CHECK ('USDC' IN (sell_currency, buy_currency) AND sell_currency <> buy_currency);

-- 2. Party data the gate needs.
ALTER TABLE users
  ADD COLUMN country text NOT NULL DEFAULT 'ZZ' CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN legal_name text CHECK (length(legal_name) BETWEEN 2 AND 200);  -- set from KYC; needed for Travel Rule

-- 3. New system accounts: funds we must not release.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN
  ('user_wallet','custody_float','payout_clearing','fx_inventory','fee_revenue','blocked_funds','compliance_hold'));
INSERT INTO accounts (kind, currency) VALUES ('blocked_funds','USDC'), ('compliance_hold','USDC');

ALTER TABLE transfers DROP CONSTRAINT transfers_kind_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_kind_check CHECK (kind IN
  ('p2p','payout_bank','fx','card_spend','remittance_in','crypto_withdrawal'));

-- 4. Evidence of every address screening (what we knew, when). Append-only.
CREATE TABLE address_screenings (
  id           bigserial PRIMARY KEY,
  network      text NOT NULL,
  address      text NOT NULL,
  risk         text NOT NULL CHECK (risk IN ('clear','high_risk','sanctioned')),
  provider_ref text NOT NULL,
  screened_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON address_screenings (network, address, screened_at DESC);

-- 5. Outbox for on-chain withdrawals: the ledger debit and the "please send" instruction commit
--    atomically; a worker hands queued rows to the custodian using transfer_id as idempotency key.
CREATE TABLE crypto_withdrawals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL UNIQUE REFERENCES transfers(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  network       text NOT NULL,
  address       text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','broadcast','confirmed','failed')),
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 6. Inbound deposits. (network, tx_hash) is the idempotency key: a replayed webhook is a no-op.
CREATE TABLE crypto_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  network       text NOT NULL,
  tx_hash       text NOT NULL,
  from_address  text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  disposition   text NOT NULL CHECK (disposition IN ('credited','held','blocked')),
  ledger_txn_id uuid NOT NULL REFERENCES ledger_transactions(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, tx_hash)
);

ALTER TABLE compliance_decisions ADD COLUMN deposit_id uuid REFERENCES crypto_deposits(id);

-- 7. Travel Rule data sent/kept for each qualifying transfer. Append-only.
CREATE TABLE travel_rule_records (
  id          bigserial PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  originator  jsonb NOT NULL,
  beneficiary jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 8. OFAC filings owed: blocked property (31 CFR 501.603) and rejected transactions (501.604),
--    each due within 10 business days. A daily job alerts on anything 'due' near its deadline.
CREATE TABLE ofac_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type  text NOT NULL CHECK (report_type IN ('blocked_property','rejected_transaction')),
  user_id      uuid NOT NULL REFERENCES users(id),
  transfer_id  uuid REFERENCES transfers(id),
  deposit_id   uuid REFERENCES crypto_deposits(id),
  reasons      text[] NOT NULL,
  currency     text NOT NULL,
  amount_minor bigint NOT NULL,
  due_by       date NOT NULL,
  status       text NOT NULL DEFAULT 'due' CHECK (status IN ('due','filed')),
  filed_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((transfer_id IS NULL) <> (deposit_id IS NULL)),
  CHECK ((status = 'filed') = (filed_at IS NOT NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['address_screenings','travel_rule_records'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;
