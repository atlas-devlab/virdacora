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
need `services/oracle/db/002_timestamp_order.sql` before deploying the current
writer. Stop writers, verify a backup, run the migration with `ON_ERROR_STOP`,
then start the new code. It adds NOT NULL ordering keys; the previous writer
cannot populate them. See the [IT/EN migration and rollback notes](TIMESTAMP_ORDER_IT_EN.md#installazione-e-archivi-preesistenti).

## Production gates

1. Independent Solidity audit and invariant fuzzing.
2. Testnet pilot with no physical actuator and a valueless test token.
3. Multisig plus timelock administration; remove deployer privileges.
4. At least three independently operated oracle images and two data paths.
5. External review of metric profiles and TerraLex policy by the affected
   community and domain experts.
6. Legal review before token distribution, fundraising, or physical action.
7. Public incident response, pause, migration, and treasury accounting plans.
