-- Additive storage for exact exported packets; no fabricated legacy backfill.
BEGIN;

CREATE TABLE IF NOT EXISTS assessment_evidence (
  receipt_id CHAR(66) PRIMARY KEY,
  assessment_id CHAR(66) NOT NULL REFERENCES assessments(assessment_id),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX IF NOT EXISTS assessment_evidence_assessment
  ON assessment_evidence (assessment_id);

COMMIT;
