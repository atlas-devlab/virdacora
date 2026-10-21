# Oracle API

The service listens on port `8787` by default.

| Method | Path | Purpose | Authentication |
| --- | --- | --- | --- |
| GET | `/healthz` | process liveness and active policy hash; no database probe | none |
| GET | `/readyz` | configured-store readiness: 200 ready or 503 not ready | none |
| POST | `/v1/sensors` | register an Ed25519 sensor | `x-admin-token` |
| POST | `/v1/observations` | submit a signed observation | sensor signature |
| POST | `/v1/assessments/run` | run model and TerraLex policy | `x-oracle-token` |
| GET | `/v1/evidence-receipts/:receiptId` | retrieve one retained exact evidence packet | `x-oracle-token` |
| GET | `/v1/assessments/:assessmentId/evidence-receipts` | bounded receipt-ID catalog for a known assessment | `x-oracle-token` |
| GET | `/v1/regions/:regionId/metrics/:metric/latest` | latest assessment | none in MVP |

The assessment response contains `assessment`, the TerraLex `decision`, an optional
reversible `actionDraft`, an exportable `evidenceReceipt`, and its `evidenceReceiptId`. The service intentionally
does not hold a treasury key or vote credential.

`evidenceReceipt` carries the exact analytical core (including ordered observation
IDs), original signed observations, assessment and the three-field public-key
bindings captured by the archive check. Successful runs save it together with
the assessment. PostgreSQL uses one transaction and an additional table; memory
mode retains it only for that process lifetime. The assessment table and latest
endpoint remain flat. Retrieve the retained packet by its content-derived
`evidenceReceiptId` at the authenticated endpoint above (`Cache-Control: no-store`).
Unknown receipts return `404 EVIDENCE_RECEIPT_NOT_FOUND`; an incompatible body
already stored under the assessment ID returns `409 ASSESSMENT_CONFLICT` on save.
Retrieval checks packet ID and assessment consistency, not key authority.
`pnpm verify:evidence <receipt.json> <trusted-registry.json>`
verifies it offline against a mandatory, separately supplied public-key registry.
Bundled keys are not a trust source. See [receipt format, usage and trust limits
(IT/EN)](EVIDENCE_RECEIPT_IT_EN.md). The persisted assessment, numerical recipe,
model versions and existing hash construction are unchanged. Existing databases
require migration `003_evidence_receipts.sql`. See [atomic persistence and recovery
(IT/EN)](EVIDENCE_PERSISTENCE_IT_EN.md) for variants, migration and outcome limits.

The catalog accepts `limit` (strict decimal integer, default 20, range 1–100) and
optional `after` (lowercase 0x-prefixed 64-digit hex ID). It returns
`{assessmentId, receiptIds, nextAfter?}`; `nextAfter` is the last returned ID only
when a further row exists. IDs sort strictly ascending in ASCII order. A cursor
is an exclusive ordering bound and need not exist. Unknown/legacy assessments
return 200 with an empty array. Authentication precedes validation and lookup;
all catalog responses use `Cache-Control: no-store`. Bodies, signatures, keys
and totals are not returned. See [IT/EN catalog semantics and limits](RECEIPT_CATALOG_IT_EN.md).

Before a new assessment, selected archived rows must pass strict schema,
original observation ID, signature, unique ID/sequence and request/sensor routing
checks against the current sensor registry. All rows are snapshotted before
asynchronous key lookups. Invalid evidence returns static HTTP 422
`{"error":"INVALID_ARCHIVED_EVIDENCE","message":"archived observation evidence is invalid"}`
before analysis, assessment persistence or policy evaluation. Registry access
failures follow the generic 500 path. Historical signatures are not rejected
solely because their sensor is now inactive or their timestamps are outside the
live ingestion window. No old records are rewritten or silently skipped. See
[archive integrity and its limits (IT/EN)](ARCHIVE_INTEGRITY_IT_EN.md).

For `water.oxygen.mg_l`, accepted exact unit strings are `mg/L`, `ug/L`,
`µg/L` (U+00B5 micro sign) and `μg/L` (U+03BC Greek mu). Microgram values are
divided by 1000 only in the analytical number vector. Stored signed values,
units, signatures and observation IDs are never normalized or re-signed.
A validly signed unsupported oxygen unit returns `422 INVALID_OBSERVATION_UNIT`
before insertion; it does not consume the sensor sequence. An invalid signature
still returns `401 INVALID_SIGNATURE` before semantic unit validation.

The oxygen model version is `terravoce-linear-risk-v2-oxygen-units`; its numerical
assessment fields are in mg/L (slope in mg/L per hour). Analysis rejects the
entire selected window with 422 if it contains an unsupported legacy oxygen
unit: no assessment or action draft is produced. It does not silently skip rows.
Oxygen `GET .../latest` selects only that current model version, ordered by
measurement timestamp and then ID. An archive with only older oxygen assessments
returns `404 ASSESSMENT_NOT_FOUND` until an explicit successful current-version
run; older assessments are not rewritten or automatically recalculated. Other
metrics retain the previous model version and latest-selection behavior. See the
[unit contract, synthetic tests and compatibility notes (IT/EN)](OXYGEN_UNITS_IT_EN.md).

`/readyz` returns only `{"status":"ready"}` or `{"status":"not_ready"}` with
`Cache-Control: no-store`. Its HTTP deadline is two seconds; concurrent requests
share one pending store probe until it settles, even after an HTTP timeout. Each
subsequent request checks afresh. PostgreSQL probes check required columns, access
and writable session mode without changing records. Memory mode reports only the
in-memory store's readiness, not persistence. See the
[readiness contract and real recovery tests](DATABASE_READINESS_IT_EN.md).

