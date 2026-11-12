-- Ongoing screening and job evidence.
ALTER TABLE users ADD COLUMN screened_at timestamptz;

CREATE TABLE person_screenings (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  result       text NOT NULL CHECK (result IN ('clear','pending','potential_match','confirmed_match')),
  provider_ref text NOT NULL,
  screened_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON person_screenings (user_id, screened_at DESC);

-- Every scheduled-job run and its full report: proof the controls actually ran.
CREATE TABLE job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  ok          boolean NOT NULL,
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person_screenings','job_runs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;
