-- Bounded keyset lookup by assessment, matching ASCII receipt-ID ordering.
BEGIN;
CREATE INDEX IF NOT EXISTS assessment_evidence_catalog
  ON assessment_evidence (assessment_id, receipt_id COLLATE "C");
COMMIT;
