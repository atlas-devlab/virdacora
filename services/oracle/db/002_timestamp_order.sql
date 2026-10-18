-- Ordering contract v1: UTC epoch milliseconds, then lowercase hexadecimal ID.
-- Keep the original TIMESTAMPTZ columns and JSON bodies unchanged.
-- Run with ON_ERROR_STOP and without concurrent application writers.
BEGIN;

ALTER TABLE observations ADD COLUMN IF NOT EXISTS observed_at_ms BIGINT;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generated_at_ms BIGINT;

-- Existing rows must have the explicit-offset ISO text expected by the Oracle.
-- Fail rather than invent a zone or silently use an already rounded column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM observations WHERE observed_at_ms IS NULL AND (
      jsonb_typeof(body->'observedAt') IS DISTINCT FROM 'string' OR
      (body->>'observedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    )
  ) OR EXISTS (
    SELECT 1 FROM assessments WHERE generated_at_ms IS NULL AND (
      jsonb_typeof(body->'generatedAt') IS DISTINCT FROM 'string' OR
      (body->>'generatedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    )
  ) THEN
    RAISE EXCEPTION 'Timestamp-order migration requires original explicit-offset ISO timestamps';
  END IF;
END
$$;

-- Truncate the TEXT fraction before PostgreSQL can round it to microseconds.
-- E.g. .1239999 must stay in millisecond .123, not round up to .124.
-- FLOOR also handles instants before the Unix epoch (unlike truncating to zero).
UPDATE observations
SET observed_at_ms = floor(extract(epoch FROM
  regexp_replace(body->>'observedAt', '([.][0-9]{3})[0-9]+', '\1')::timestamptz
) * 1000)::bigint
WHERE observed_at_ms IS NULL;

UPDATE assessments
SET generated_at_ms = floor(extract(epoch FROM
  regexp_replace(body->>'generatedAt', '([.][0-9]{3})[0-9]+', '\1')::timestamptz
) * 1000)::bigint
WHERE generated_at_ms IS NULL;

ALTER TABLE observations ALTER COLUMN observed_at_ms SET NOT NULL;
ALTER TABLE assessments ALTER COLUMN generated_at_ms SET NOT NULL;

CREATE INDEX IF NOT EXISTS observations_region_metric_time_ms
  ON observations (region_id, metric, observed_at_ms DESC, observation_id COLLATE "C" DESC);
CREATE INDEX IF NOT EXISTS assessments_region_metric_time_ms
  ON assessments (region_id, metric, generated_at_ms DESC, assessment_id COLLATE "C" DESC);

COMMIT;
