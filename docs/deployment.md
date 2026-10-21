# Deployment

## Local process

```bash
pnpm install
pnpm build
pnpm test
pnpm e2e
pnpm --filter @terravoce/oracle dev
```

## Containers

```bash
docker compose up --build
curl http://localhost:8877/healthz
curl -i http://localhost:8877/readyz
```

PostgreSQL is considered ready only after `pg_isready` succeeds. Its startup
script creates replay-resistant observation tables and deterministic assessment
storage.

Oracle's Compose healthcheck uses `/readyz`, not `/healthz`. The former returns
503 if its configured store is unavailable, has an incompatible schema or has a
read-only session; the latter checks process liveness only. The probe never
inserts data. Health status may lag the fault because Compose checks every ten
seconds and applies its configured retries. `unhealthy` is a status, not an
automatic restart or failover policy. See the
[IT/EN contract, recovery evidence and limitations](DATABASE_READINESS_IT_EN.md).

## Controlled Oracle shutdown

SIGTERM and SIGINT now call Fastify `app.close()`: stop accepting new work, drain
requests already in progress, then run the existing store-close hook. Repeated
signals share the same shutdown. Successful close exits 0; a rejected close or
the 20-second application deadline exits 1 with a static diagnostic. Compose
allows 25 seconds before it can force termination. Do not shorten that outer
grace below the application budget without reviewing the consequences.

Neither timeout nor forced exit proves that an interrupted write did not commit.
There are no automatic write retries or exactly-once guarantees. A client that
loses its response still has an uncertain outcome. See the
[Linux signal test and IT/EN explanation](ORACLE_SHUTDOWN_IT_EN.md).

Initialization scripts run only on a new PostgreSQL volume. Existing databases
need `services/oracle/db/002_timestamp_order.sql` and then
`services/oracle/db/003_evidence_receipts.sql` before deploying the current
writer. Stop writers, verify a backup, run the migration with `ON_ERROR_STOP`,
then start the new code. It adds NOT NULL ordering keys; the previous writer
cannot populate them. See the [IT/EN migration and rollback notes](TIMESTAMP_ORDER_IT_EN.md#installazione-e-archivi-preesistenti).

Migration 003 adds `assessment_evidence` without rewriting old records or inventing
legacy receipts. Oracle readiness now requires its columns and SELECT/INSERT
access. Run it with `ON_ERROR_STOP` after a verified backup and apply it only to
the explicitly intended database. New-volume Compose initialization and isolated
test runners include it. A code rollback may leave this additive table intact;
the older writer will not retain receipts for its later assessments. Do not drop
the table as a casual rollback: it contains retained evidence. See the
[IT/EN persistence contract](EVIDENCE_PERSISTENCE_IT_EN.md).

Migration `004_receipt_catalog.sql` adds the composite assessment/receipt-ID
index matching the catalog's `COLLATE "C"` keyset query. Apply it after 003 for
existing databases; new-volume Compose initialization and isolated runners include
it. It changes no rows or columns. Readiness still checks table/column/access
compatibility, not index presence or a performance SLA. The catalog remains a
bounded metadata query; see its [IT/EN contract](RECEIPT_CATALOG_IT_EN.md).

## Optional receipt reader credential

Configure `EVIDENCE_READ_API_TOKEN` in the process environment, or in the private
`.env` consumed by Compose. The example leaves it empty, which disables this
role; there is no default reader secret. Local `pnpm` does not automatically
load `.env`. Generate a distinct random value, 32–256 visible ASCII characters;
length validation cannot measure entropy. Do not reuse the admin/Oracle value.
Invalid active configuration fails before creating the store. Configuration
errors are static and contain no token value.

Clients send it in `x-evidence-token` only on the receipt catalog and packet GET
routes, over protected transport. Keep it out of URLs, source control and logs.
The legacy Oracle credential can still read those routes; it remains a writer
credential. Either correct header grants a read, even if the other is wrong.
Do not distribute the Oracle token to read-only clients.

Rotation/revocation requires a configuration update and process restart; no
individual identity, region scope or token-management service is added. Clearing
the optional value disables the reader on restart without modifying retained
data or the database schema. Existing development defaults for admin/Oracle
are unchanged and must not be used as production secrets. This feature neither
deploys a service nor configures HTTPS. See the [IT/EN access contract](EVIDENCE_ACCESS_IT_EN.md).

## Production gates

1. Independent Solidity audit and invariant fuzzing.
2. Testnet pilot with no physical actuator and a valueless test token.
3. Multisig plus timelock administration; remove deployer privileges.
4. At least three independently operated oracle images and two data paths.
5. External review of metric profiles and TerraLex policy by the affected
   community and domain experts.
6. Legal review before token distribution, fundraising, or physical action.
7. Public incident response, pause, migration, and treasury accounting plans.
