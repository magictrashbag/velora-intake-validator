-- Local denylist of sanctioned crypto addresses (e.g. new OFAC SDN digital-currency identifiers).
-- Checked BEFORE the screening vendor, so a listing takes effect the moment compliance enters it,
-- even if the vendor's data lags. Append-only: delisting is a separate, explicit decision.
CREATE TABLE sanctioned_addresses (
  id          bigserial PRIMARY KEY,
  network     text NOT NULL,
  address     text NOT NULL,
  source      text NOT NULL,
  listed_on   date,
  added_by    uuid NOT NULL REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, address)
);
CREATE TRIGGER sanctioned_addresses_append_only BEFORE UPDATE OR DELETE ON sanctioned_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX ON crypto_deposits (network, from_address);
CREATE INDEX ON crypto_withdrawals (network, address);
