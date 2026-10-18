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
```

PostgreSQL is considered ready only after `pg_isready` succeeds. Its startup
script creates replay-resistant observation tables and deterministic assessment
storage.

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
