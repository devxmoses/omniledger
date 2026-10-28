# OmniLedger

OmniLedger is a payments platform built as a set of small backend services in one [Nx](https://nx.dev) monorepo.

The first service is **payments-ledger**, a double-entry ledger that records every movement of money. Other services (identity, KYC, payouts, notification, reconciliation, insights) are planned. Each one already has its own database in the local Postgres setup.

## Tech stack

- **Node.js 24** and **TypeScript**
- **NestJS** for the services
- **PostgreSQL 17**, run with Docker Compose
- **node-pg-migrate** for database migrations, written in plain SQL
- **Jest** for tests, **ESLint** and **Prettier** for code style
- **Nx** to run builds, tests and lint across the workspace
- **GitHub Actions** for CI

## Project layout

```
apps/
  payments-ledger/        The ledger service (NestJS)
  payments-ledger-e2e/    End-to-end tests for the ledger API
infra/
  postgres/init/          Script that creates one database per service
packages/                 Shared libraries (empty for now)
docker-compose.yml        Local Postgres
```

## Getting started

### 1. What you need

- Node.js 24 and npm
- Docker with Docker Compose

### 2. Install dependencies

```sh
npm install
```

### 3. Start Postgres

```sh
docker compose --profile core up -d
```

The first time it starts, Postgres runs [infra/postgres/init/01-create-service-databases.sh](infra/postgres/init/01-create-service-databases.sh). That script creates a login and a database for each service. In local development each password is the same as the service name, so the ledger uses user `payments_ledger`, password `payments_ledger` and database `payments_ledger`.

The init script only runs when the data volume is empty. To start again from a clean database:

```sh
docker compose --profile core down -v
docker compose --profile core up -d
```

### 4. Run the migrations

The service reads its connection string from `DATABASE_URL` in `apps/payments-ledger/.env`. That file isn't committed, so create it from the example the first time:

```sh
cp apps/payments-ledger/.env.example apps/payments-ledger/.env
```

The example points at the local Postgres:

```
DATABASE_URL=postgresql://payments_ledger:payments_ledger@localhost:5432/payments_ledger
```

Then apply the migrations:

```sh
npx nx run @org/payments-ledger:migrate
```

### 5. Start the service

```sh
npx nx serve @org/payments-ledger
```

It runs on http://localhost:3000/api. Set `PORT` to use a different port.

## Common commands

| What | Command |
| --- | --- |
| Start the ledger in dev mode | `npx nx serve @org/payments-ledger` |
| Build the ledger | `npx nx build @org/payments-ledger` |
| Run unit tests | `npx nx test @org/payments-ledger` |
| Run end-to-end tests (needs the service running) | `npx nx e2e @org/payments-ledger-e2e` |
| Lint | `npx nx lint @org/payments-ledger` |
| Apply migrations | `npx nx run @org/payments-ledger:migrate` |
| Create a new migration | `npx nx run @org/payments-ledger:migrate-create --name=<name>` |
| Run everything CI runs | `npx nx run-many -t lint test build typecheck e2e` |
| See how projects connect | `npx nx graph` |

## The payments ledger

### What it does

The ledger is the record of truth for money in OmniLedger. It records each payment, refund or fee as a **transaction**. A transaction is made of two or more **journal entries**, and each entry either debits or credits an account.

Double-entry bookkeeping means every transaction has to balance: the debits add up to exactly the credits. For example, money can't leave one account without arriving in another, so money can't appear from nowhere or vanish.

### Main ideas

- **Account**: a place money is held. It has a type (`asset`, `liability`, `revenue` or `expense`) and exactly one currency. An account either belongs to a merchant or is a system account owned by the platform.
- **Transaction**: one business event, such as a payment. Once a transaction is posted, it is never edited or deleted.
- **Journal entry**: one line of a transaction. It says which account, debit or credit, and how much.
- **Reversal**: to undo a transaction, the ledger posts a new transaction with the same lines in the opposite direction. The original is marked `reversed`, and it can only be reversed once.
- **Money**: amounts are stored as whole numbers in the currency's smallest unit (₦12.50 is stored as `1250` kobo). The code uses `bigint` and never floats, so there are no rounding errors.

### Rules the ledger enforces

The service checks these rules before it writes anything. The database checks them again, so bad data can't get in even if something skips the service.

| Rule | Where it's checked |
| --- | --- |
| A transaction has at least two lines | service |
| Every amount is positive | service and database |
| Debits equal credits | service, plus a database trigger at commit |
| One currency per transaction, matching each account's currency | service, plus a database trigger and foreign key |
| Accounts that can't go negative are never overdrawn | service, with the accounts locked first so two requests can't overspend at the same time |
| Journal entries can only be added, never changed or deleted | database triggers |
| A transaction's only allowed change is `posted` to `reversed` | database trigger |
| The same idempotency key never creates two transactions | unique constraint, and the service returns the original transaction |

When a rule is broken, the service throws a typed error with a fixed code, such as `UNBALANCED_POSTING`, `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `ACCOUNT_NOT_FOUND` or `ALREADY_REVERSED`. These are defined in [src/domain/errors.ts](apps/payments-ledger/src/domain/errors.ts).

### What it can do so far

[LedgerService](apps/payments-ledger/src/application/ledger.service.ts) supports:

- `post`: record a balanced transaction. It's safe to retry with the same idempotency key.
- `reverse`: undo a transaction.
- `getBalance`: get the current balance of one account.
- `getStatement`: get an account's entries, newest first, each with the balance after it (like a bank statement, up to 500 lines a page).
- `getMerchantBalances`: get every account a merchant owns, with balances.
- `getTrialBalance`: get total debits and credits per currency across the whole ledger. These should always be equal.

These aren't available over HTTP yet. Right now the API only has the starter `GET /api` endpoint. REST endpoints are the next milestone.

### Code layout

```
apps/payments-ledger/src/
  domain/         Pure business rules: money, accounts, postings, errors. No database code.
  application/    LedgerService: runs the rules inside database transactions.
  db/             Postgres pool, repository (SQL queries), transaction runner, migrations.
  app/            NestJS root module and controller.
  main.ts         Starts the server.
```

### Database schema

Migrations live in [apps/payments-ledger/src/db/migrations](apps/payments-ledger/src/db/migrations) and run in order:

1. `0001_create-currency`: the currencies the ledger supports, with their number of decimal places (seeded with NGN, USD and EUR).
2. `0002_create-account`: accounts, with one account per merchant, currency and purpose.
3. `0003_create-transaction`: transactions, idempotency keys and reversal links.
4. `0004_journal-entry`: journal entries, with indexes for statements.
5. `0005_ledger-invariants`: triggers that enforce balance, single currency and append-only storage.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push to `main` and on every pull request. It installs dependencies, checks formatting, then runs lint, test, build, typecheck and e2e for the projects.

## License

MIT
