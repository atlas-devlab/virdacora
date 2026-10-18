# Oracle API

The service listens on port `8787` by default.

| Method | Path | Purpose | Authentication |
| --- | --- | --- | --- |
| GET | `/healthz` | process liveness and active policy hash; no database probe | none |
| GET | `/readyz` | configured-store readiness: 200 ready or 503 not ready | none |
| POST | `/v1/sensors` | register an Ed25519 sensor | `x-admin-token` |
| POST | `/v1/observations` | submit a signed observation | sensor signature |
| POST | `/v1/assessments/run` | run model and TerraLex policy | `x-oracle-token` |
| GET | `/v1/regions/:regionId/metrics/:metric/latest` | latest assessment | none in MVP |

The assessment response contains the reproducible `evidenceHash`, the TerraLex
decision, and an optional reversible `actionDraft`. The service intentionally
does not hold a treasury key or vote credential.

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

