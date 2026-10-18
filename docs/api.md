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

`/readyz` returns only `{"status":"ready"}` or `{"status":"not_ready"}` with
`Cache-Control: no-store`. Its HTTP deadline is two seconds; concurrent requests
share one pending store probe until it settles, even after an HTTP timeout. Each
subsequent request checks afresh. PostgreSQL probes check required columns, access
and writable session mode without changing records. Memory mode reports only the
in-memory store's readiness, not persistence. See the
[readiness contract and real recovery tests](DATABASE_READINESS_IT_EN.md).

