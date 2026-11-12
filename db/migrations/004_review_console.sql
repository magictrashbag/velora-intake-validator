-- Review console: staff, four-eyes review cases, append-only actions.

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  role        text NOT NULL CHECK (role IN ('reviewer','compliance_officer','admin')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  token_hash  bytea PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- What a held transfer needs to be executed later (address, FX quote amounts...).
ALTER TABLE transfers ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
-- The ledger txn that moved the reserve OUT of compliance_hold (payment, refund or block).
ALTER TABLE transfers ADD COLUMN release_ledger_txn_id uuid REFERENCES ledger_transactions(id);
ALTER TABLE transfers DROP CONSTRAINT transfers_hold_reserved;
ALTER TABLE transfers ADD CONSTRAINT transfers_hold_reserved CHECK (
  (status <> 'held_for_review' OR (hold_ledger_txn_id IS NOT NULL AND release_ledger_txn_id IS NULL))
  AND (hold_ledger_txn_id IS NULL OR status = 'held_for_review' OR release_ledger_txn_id IS NOT NULL)
);

ALTER TABLE crypto_deposits ADD COLUMN resolved_ledger_txn_id uuid REFERENCES ledger_transactions(id);
ALTER TABLE crypto_deposits ADD COLUMN resolved_at timestamptz;

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN
  ('p2p','deposit','payout','fx','fee','card','adjustment','crypto_withdrawal','hold','hold_release','block'));

CREATE TABLE review_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('transfer','deposit','user')),
  subject_id    uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  reasons       text[] NOT NULL,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','awaiting_second_approval','approved','rejected','blocked')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  CHECK ((status IN ('open','awaiting_second_approval')) = (closed_at IS NULL))
);
-- At most one live case per subject.
CREATE UNIQUE INDEX review_cases_one_open ON review_cases (subject_type, subject_id)
  WHERE status IN ('open','awaiting_second_approval');
CREATE INDEX ON review_cases (status, opened_at);

CREATE TABLE review_actions (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES review_cases(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  action      text NOT NULL CHECK (action IN ('approve','reject','block','comment','execute_refused')),
  note        text NOT NULL CHECK (length(btrim(note)) >= 5),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER review_actions_append_only BEFORE UPDATE OR DELETE ON review_actions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER review_actions_no_truncate BEFORE TRUNCATE ON review_actions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Blocking a held Bs amount needs a VES blocked-funds account.
INSERT INTO accounts (kind, currency) VALUES ('blocked_funds','VES');
