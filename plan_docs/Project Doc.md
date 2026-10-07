# OmniLedger — Project Doc

Oct 4, 2026 · @Moses

## Overview

OmniLedger is an event-driven multi-currency ledger and payment orchestrator: the transaction engine a payment provider runs — the layer that authorises, records, settles and reconciles money — plus the merchant-facing gateway and dashboard on top. It is built to demonstrate the concerns that define serious backend work in payments: API design, third-party integration, event-driven architecture, and correctness under concurrency and failure. Nothing in the design is tied to a single provider, currency or jurisdiction.

Merchants sign up, pass KYC, and receive scoped API keys. They accept payments through a pluggable provider adapter — Paystack and Stripe sandboxes both implemented — into multi-currency wallets (NGN, USD and EUR) backed by an immutable double-entry ledger. They receive HMAC-signed webhooks, watch transactions land live in a dashboard, initiate payouts under maker-checker approval, and query their data in plain English. A T+1 job reconciles the internal ledger against the provider's settlement records and raises an ??exceptions queue??.

**What it is built to prove**

- Accounting correctness: double-entry bookkeeping, integer minor units, no floating-point money, currency-segregated balancing.
- Distributed-systems judgment: where to draw service boundaries, and which boundary to refuse to draw.
- Reliability under failure: idempotency, transactional outbox, ordered event streams, retries, ??dead-letter handling, circuit breakers??.
- Integration abstraction: one ??provider-agnostic interface with ??two live implementations??, so neither market's reviewer sees a system welded to a provider they do not use.
- ??Auditability: append-only, hash-chained audit trail and replayable event history??.
- ??Enterprise delivery practice: contract-first APIs, Testcontainers integration tests, CI gates, ADRs, runbooks.??

**One-line description**

OmniLedger: an event-driven multi-currency ledger and payment orchestrator in TypeScript — immutable double-entry ledger, distributed idempotency, Kafka event streaming, ??tamper-evident audit logs??, and a merchant dashboard.

**Scope boundary.** This is a sandbox system. It never touches live funds, holds no production card data, and is out of ??PCI?? scope by design: card details are never captured, stored or transmitted — the provider's hosted checkout handles them.

## Architecture and service boundaries

Nine deployables: seven domain services, ??one edge gateway, one dashboard. Services are split along failure and scaling boundaries, not along ??noun boundaries — which is why payments and the ledger stay together, and why webhook delivery does not.

| Deployable | Responsibility | Why it is its own service |
| --- | --- | --- |
| API Gateway / BFF | Routing, API-key auth, per-credential rate limiting, request validation, correlation IDs | Edge concern with no domain logic; isolates cross-cutting policy from business services |
| Identity | Merchant accounts, scoped API keys, hashing, rotation | Distinct bounded context; auth changes on its own cadence |
| KYC | Verification provider integration, status state machine | Slow and third-party dependent; separate compliance and audit surface |
| Payments + Ledger | Payment orchestration and double-entry bookkeeping | One consistency boundary — deliberately not split |
| Payouts | Bank transfers, maker-checker approval, provider retries | Different failure profile and approval workflow from inbound payments |
| Notification | Signed webhooks, SMS/email, WebSocket pushes | Slow and bursty; must never block the payment path |
| Reconciliation | T+1 settlement matching, exceptions queue | Scheduled and read-only; scales independently |
| Insights (AI) | Fraud explanations, natural-language transaction search | An AI outage must never touch payments |
| Dashboard (Next.js) | Merchant UI | Separate release cadence from the API |

**The boundary that is refused.** Payments and the ledger stay in one service because a payment and its journal entries must commit in a single database transaction. Splitting them forces a saga with compensating entries, creating windows where money has moved but the books do not balance. Production payment systems keep the ledger as a single consistency boundary for this reason. This is recorded as ??ADR-001.

**Service conventions**

- One database per service. No shared tables, no cross-service joins.
- Async-first over Kafka. Synchronous calls only where the caller genuinely cannot proceed (API-key verification, KYC status checks).
- Event contracts defined in a schema registry before implementation, with backward-compatible evolution.
- Every service exposes health, readiness and liveness endpoints, emits OpenTelemetry traces, and logs structured JSON carrying the correlation ID.
- ??Payouts posts to the ledger by issuing a command and reacting to the result event. It never writes journal entries directly.

&#91;embedded content: service topology · 9 deployables, 1 refused boundary\]

Synchronous calls run only along the top edge, where a caller cannot proceed without an answer. Everything below Kafka reacts to events, so a slow consumer never delays a payment.

## Data model

The ledger is the schema that matters. Everything else serves it.

**Core ledger tables**

| Table | Key columns | Notes |
| --- | --- | --- |
| `currency` | code, exponent, name | Exponent is the minor-unit scale: NGN 2, USD 2, JPY 0. Never assume 100. |
| `account` | id, merchant\_id, currency\_code, account\_type, is\_system | account\_type is one of asset, liability, revenue, expense. Merchant balances are liabilities. |
| `transaction` | id, external\_ref, idempotency\_key, status, created\_at | The envelope. Carries no amount of its own. |
| `journal_entry` | id, transaction\_id, account\_id, direction, amount\_minor, currency\_code | amount\_minor is a BIGINT. direction is debit or credit. Append-only. |
| `balance_snapshot` | account\_id, as\_of, available\_minor, ledger\_minor | Periodic rollup so balance reads do not scan all history. |
| `fx_trade` | id, from\_transaction\_id, to\_transaction\_id, rate, rate\_id, quoted\_at | Joins the two same-currency transactions that make one conversion. |
| `fx_rate` | id, base, quote, rate, effective\_from, source | Versioned. Every trade records which rate row it used. |

**Invariants enforced in the database, not just in code**

- Debits equal credits within every transaction, and within a single currency. A cross-currency transaction is rejected.
- `amount_minor` is always positive; direction carries the sign.
- Journal entries are append-only: no UPDATE, no DELETE. Corrections post a reversing transaction that references the original.
- Account balance is derived from journal entries, never stored as a mutable column.

**Pending vs. posted.** Authorised-but-uncaptured funds post to a holding account, so `available` and `ledger` balances differ. Capture moves the holding entry to the merchant's settled account; expiry reverses it.

**Concurrency.** Balance mutations take `SELECT … FOR UPDATE` on the account row inside the transaction. Running balances are computed with window functions over journal entries. A test asserts two concurrent withdrawals cannot overdraw.

**Supporting tables**??

| Table | Purpose |
| --- | --- |
| `outbox` | Event rows written in the same transaction as the business change; Debezium streams them to Kafka. |
| `idempotency_record` | Key, request hash, cached response, expiry. Backed by a Redis lock for the in-flight window. |
| `audit_log` | Append-only. Actor, timestamp, source IP, user agent, before/after state, `prev_hash`, `entry_hash`. |
| `processed_event` | Consumer-side dedupe: event ID plus consumer name, so at-least-once delivery is safe. |

**Hash chain.** Each audit row stores `entry_hash = SHA256(prev_hash ‖ canonical_payload)`. A verifier endpoint walks the chain and reports the first break, making tampering detectable rather than merely discouraged.

## Event contracts and Kafka topics ??

Every event reaches Kafka through the transactional outbox, never by a direct publish from application code. The business write and the event row commit together; Debezium streams the outbox table out. A crash can therefore never record a payment without publishing it.

**Topic design**

| Topic | Key | Produced by | Consumed by |
| --- | --- | --- | --- |
| `merchant.identity.v1` | merchant\_id | Identity | Gateway cache, Payments, Notification |
| `merchant.kyc.v1` | merchant\_id | KYC | Payments, Dashboard |
| `payment.lifecycle.v1` | merchant\_id | Payments | Notification, Reconciliation, Insights |
| `ledger.posting.v1` | merchant\_id | Payments | Reconciliation, Insights |
| `payout.lifecycle.v1` | merchant\_id | Payouts | Notification, Reconciliation |
| `webhook.delivery.v1` | merchant\_id | Notification | Dashboard inspector |
| `audit.trail.v1` | merchant\_id | all services | Insights, compliance export |

**Partitioning by merchant ID** guarantees per-merchant ordering, so `payment.refunded` cannot overtake `payment.succeeded` for the same merchant. Across merchants there is no ordering requirement, so partitions scale freely.

**Event envelope.** Every event carries: `event_id` (UUID), `event_type`, `event_version`, `occurred_at`, `merchant_id`, `correlation_id`, `causation_id`, and a typed `payload`. Schemas live in the registry; evolution is backward-compatible only (add optional fields, never remove or retype).

**Retry and failure topics**

- A consumer that fails a message publishes it to `<topic>.retry.5s`, then `.retry.1m`, then `.retry.15m`, with exponential backoff and jitter.
- After the final retry the message lands in `<topic>.dlt`, visible in the dashboard, with a documented replay procedure.
- Retry topics mean a poisoned message never blocks its partition — the gap Kafka leaves compared with a broker that acknowledges per message.

**Idempotent consumers.** Kafka delivers at least once, so every consumer records `event_id` plus its own name in `processed_event` inside the same transaction as its side effect, and silently skips duplicates.

**Replay.** Topics retain long enough to rebuild a consumer's state from zero and to trace any disputed transaction end to end. Reconciliation uses this to rebuild its matching view without touching the payment service.

## Service specifications

### API Gateway / BFF

Edge only; holds no domain logic. Terminates merchant requests, verifies the API key against an Identity-populated Redis cache, applies per-credential rate limits returning `429` with `Retry-After`, validates request bodies with Zod, injects a correlation ID, and routes onward. The README states that production would use Kong, Envoy or AWS API Gateway; it is hand-built here to demonstrate the concerns.

### Identity

Owns merchants, users and API keys. Keys are generated with a public prefix and a secret half stored only as a hash, scoped read or write, and rotatable with an overlap window. Publishes `merchant.identity.v1` on creation, scope change and revocation so the gateway cache stays current. The README notes production would typically use Keycloak or Auth0 rather than hand-rolled auth.

### KYC

Drives a status state machine: `unverified → pending → verified | rejected`. Calls a verification provider's sandbox behind a circuit breaker with bounded retries, behind an adapter interface, so the identity document required is configurable per jurisdiction rather than hardcoded. Identity numbers and bank details are encrypted at rest and masked everywhere they surface. Publishes `merchant.kyc.v1`. Payments consumes it: an unverified merchant may test, but cannot settle or pay out.

### Payments + Ledger

The core. Owns payment orchestration, wallets, the chart of accounts and all journal entries.

- Accepts a payment intent carrying an `Idempotency-Key`, initialises a transaction through the provider adapter, and returns a checkout reference.
- Talks to providers through one `PaymentProvider` interface — `initialise`, `verify`, `refund`, `parseWebhook`, `fetchSettlement` — with Paystack and Stripe sandbox implementations behind it. Adding a third provider is a new adapter, not a change to the ledger.
- Consumes the provider's inbound webhook, verifies its signature, deduplicates by provider event ID, and posts the resulting journal entries.
- Holds authorised-but-uncaptured funds in a holding account, so available and ledger balances diverge correctly.
- Executes FX conversion as two same-currency transactions joined by an `fx_trade` row carrying the exact rate used.
- Writes every state change to the hash-chained audit log and every event to the outbox, in the same transaction.

### Payouts

Owns withdrawal requests and their approval state. Large or flagged payouts require maker-checker: the initiating actor cannot approve. Posts to the ledger by issuing a command and reacting to `ledger.posting.v1`, never by writing journal entries itself — a saga with a documented compensating reversal if the bank transfer ultimately fails. Bank calls sit behind a circuit breaker with bounded retries.

### Notification

Consumes lifecycle topics and delivers outbound webhooks signed with HMAC SHA-256, plus SMS, email and WebSocket pushes. Implements the retry topic ladder with jitter, a dead-letter topic, and a per-merchant circuit breaker so one unresponsive endpoint does not degrade delivery for everyone. Exposes delivery history and a replay endpoint so merchants can re-request missed events.

### Reconciliation

Runs T+1 against the provider's settlement records, sorting every item into matched, unmatched (present one side only) or mismatched (present both, differing amount or status). Mismatches open an exception with a status workflow, since real operations teams resolve these by hand. Read-only with respect to the ledger: it reports breaks, it does not silently correct them.

### Insights (AI)

Read-only. Two features: a plain-English explanation of why a transaction was flagged, and natural-language search over transactions translated into a constrained query. The LLM never writes to the ledger and never sees unmasked PII. Degrades to an ordinary filter UI when unavailable.

### Dashboard (Next.js)

Signup, KYC flow, API key management, per-currency balances, filterable transactions, payout initiation and approval. Plus the four screens that make the engineering visible: a **ledger explorer** showing the debits and credits behind any transaction, a **webhook inspector** with delivery attempts and DLT contents, the **reconciliation exceptions queue**, and a **live transaction feed** over WebSockets. Interactive API docs are served alongside.

## Milestone plan

Twelve weeks at roughly 15–20 hours a week, built strictly in dependency order. Every milestone ends at a demo-able state, so the project is presentable from week 3 onward and never exists as a half-built whole.

&#91;embedded content: build order · 9 milestones over 12 weeks\]

**M1 — Ledger engine (weeks 1–2)** Currency table, chart of accounts, journal entries, balance derivation. Row locks and the concurrency test. No HTTP yet; this is proven by tests. *Done when:* a test suite demonstrates balanced double-entry posting, correct per-currency balances, and that concurrent withdrawals cannot overdraw.

**M2 — Payments and the provider adapter (weeks 3–4)** Payment intents, `Idempotency-Key` middleware with Redis locks, the provider adapter interface with a Paystack sandbox implementation, inbound webhook verification and dedupe, pending vs. posted balances. *Done when:* a sandbox payment moves end to end and a replayed request returns the cached response without double-posting. **First demo-able state.**

**M3 — Outbox and Kafka (week 5)** Outbox table, Debezium connector, topic creation, event envelope, schema registry, idempotent consumer scaffolding. *Done when:* a payment emits `payment.lifecycle.v1` and a test consumer handles a deliberately duplicated event safely.

**M4 — Notification service (weeks 6–7)** HMAC-signed webhook delivery, retry ladder with jitter, dead-letter topic, per-merchant circuit breaker, replay endpoint. *Done when:* a failing merchant endpoint exhausts retries into the DLT without affecting another merchant's delivery.

**M5 — Dashboard (week 8)** Auth, balances, transactions, ledger explorer, webhook inspector, live feed. *Done when:* a sandbox payment appears live on screen with its debits and credits visible. **Demo video becomes possible here.**

**M6 — Identity, KYC and gateway (week 9)** Extract identity and KYC as services; stand up the gateway with rate limiting and key verification. *Done when:* all merchant traffic enters through the gateway and an unverified merchant is correctly blocked from settling.

**M7 — Payouts (week 10)** Withdrawal requests, maker-checker approval, the ledger-posting saga with compensating reversal. *Done when:* a payout requires a second approver and a simulated bank failure reverses cleanly.

**M8 — Reconciliation and audit chain (week 11)** T+1 matching, exceptions queue, hash-chained audit log with a verifier endpoint. *Done when:* a deliberately injected mismatch surfaces as an exception, and tampering with an audit row is detected.

**M9 — FX, Insights and polish (week 12)** FX conversion with versioned rates, the Stripe adapter as the second provider implementation, AI explanations and natural-language search, OpenTelemetry dashboards, runbooks, ADRs, seed script, deployment, walkthrough video. *Done when:* the repository is presentable: live demo, README, diagram, ADRs, video.

**Cut order if time runs short.** Drop in this sequence, and only in this sequence: Insights, the Stripe adapter, FX, gateway extraction, KYC extraction. The adapter interface itself stays even if its second implementation goes, since the abstraction is the part that matters. Never cut the ledger invariants, idempotency, the outbox, or the tests — those are the entire point of the project.

## Testing and CI

The tests are part of the portfolio, not an afterthought. A reviewer who opens the test folder should find the hard cases, not a wall of trivial assertions.

**The tests that carry the project**

| Test | What it proves |
| --- | --- |
| Concurrent withdrawal | Two simultaneous requests against one wallet; exactly one succeeds and the balance never goes negative. |
| Idempotent replay | The same `Idempotency-Key` twice returns the identical response and posts one transaction. |
| Cross-currency rejection | A journal entry mixing NGN and USD is refused by the database, not just the service. |
| Outbox atomicity | A crash injected between the business write and the publish still yields exactly one event. |
| Duplicate event delivery | The same Kafka event delivered twice causes one side effect. |
| Webhook retry exhaustion | A failing endpoint walks the retry ladder and lands in the DLT without blocking other merchants. |
| Audit chain tampering | Editing an audit row is detected by the verifier endpoint. |
| Reversal correctness | A reversed transaction leaves both accounts at their original balances with the history intact. |

**Test pyramid.** Many unit tests over ledger arithmetic and state machines; a solid integration layer; a handful of end-to-end flows. Integration tests run against real PostgreSQL, Redis and Kafka via Testcontainers — not mocks, because the invariants being tested are enforced by the database.

**Contract tests.** Each consumer publishes the event shape it depends on; producers verify against those contracts in CI, so a schema change that would break a consumer fails the build.

**CI gates (GitHub Actions).** Lint, typecheck, unit, integration, contract tests, then security scanning: dependency audit, SAST, container scan and secret scanning. A build that fails any gate does not merge.

**Migrations.** Versioned and forward-only, applied in CI against a scratch database to catch ordering problems. Schema changes follow expand-then-contract so a deploy never requires downtime.

## Local development setup

RAM is the binding constraint, not CPU. Running everything at once costs roughly 6–7 GB before the editor and browser, so Docker Compose profiles let you start only what you are working on.

| Component | Approximate memory |
| --- | --- |
| Kafka (KRaft) | 1 GB |
| Debezium Connect | 700 MB |
| PostgreSQL | 300 MB |
| Redis | 100 MB |
| Node services (9 × \~150 MB) | 1.3 GB |
| Next.js dev server | 400 MB |
| Prometheus + Grafana | 500 MB |

**Compose profiles**

- `core` — Postgres, Redis, Payments+Ledger, gateway. The everyday working set, about 1 GB.
- `events` — adds Kafka and the Notification service.
- `cdc` — adds Debezium. Off by default in development.
- `observability` — adds Prometheus and Grafana. On only when working on telemetry.
- `full` — everything, for recording the demo.

**Two development shortcuts, both documented in the README as deliberate**

- **One Postgres container, one database per service inside it.** Logically separate, with no cross-schema queries and separate credentials, so the boundary is real even though the process is shared. Production would run separate instances.
- **A polling outbox worker in place of Debezium during development.** Debezium is the single heaviest component; the outbox contract is identical either way, so CDC is switched on only for the `cdc` profile and the demo.

**Guidance by machine.** 16 GB runs the `full` profile comfortably. 8 GB works well on profiles, and can record the demo if the editor is closed. Below 8 GB, expect to work one profile at a time. On Windows, set a memory ceiling in `.wslconfig`, since WSL2 will otherwise claim most of the host.

**Developer ergonomics.** Services run under `tsx` for fast reloads; Testcontainers runs in CI and on demand rather than on every local test run; a seed script generates realistic merchants and transaction history so no screen is ever empty.

## Trade-offs, failure modes and production gaps

This section is written for the README too. Naming what was decided, and what was left out, reads as more senior than silent omission.

**Decisions worth defending**

| Decision | Why | What it costs |
| --- | --- | --- |
| Ledger stays with payments | They must commit in one transaction; splitting creates windows where money has moved but the books do not balance | The core service is larger than the others |
| Kafka over RabbitMQ | Retained, replayable event log for audit and state rebuilding; per-merchant ordering via partitioning | Per-message retry is not native, so retry topics and a DLT are built by hand |
| Integer minor units with `BIGINT` | Floating-point money produces rounding errors that corrupt a ledger | Every amount needs explicit scaling by currency exponent |
| Hand-built gateway | Demonstrates the edge concerns explicitly | Production would use a managed gateway instead |
| Hand-rolled API-key auth | Shows key issuance, hashing and rotation | Production would use Keycloak or Auth0 |

**Failure modes, and the system's behaviour**

- **Database failover.** In-flight transactions roll back; idempotency keys make client retries safe. The outbox means no event is lost, since unpublished rows stream once the connector reconnects.
- **Payment provider outage.** The circuit breaker opens after a failure threshold; payment initialisation returns a clear `503` with `Retry-After` rather than hanging. Inbound webhooks replay when the provider recovers, and dedupe prevents double-posting.
- **A merchant endpoint that stops responding.** Its circuit breaker opens; its events walk the retry ladder into the DLT. Other merchants are unaffected, because retry topics prevent partition blocking.
- **Traffic surge.** The gateway sheds load with per-key rate limits. Kafka absorbs the burst, so the payment path stays responsive while Notification drains the backlog.
- **Kafka unavailable.** Payments continue: the business write and outbox row still commit. Events accumulate in the outbox and stream once Kafka returns. This is the main argument for the outbox pattern.
- **Consumer lag or poison message.** Lag alerts fire against the SLO; a poison message exits to the DLT after its retries, visible in the dashboard with a documented replay path.

**Production gaps, stated deliberately**

- Organisational controls a solo project cannot practise: separation of duties, change-management approval, on-call rotation, blameless postmortems.
- Single-region deployment; no tested disaster recovery, no documented RTO/RPO.
- No HSM or formal key-management lifecycle; secrets use a vault but rotation is manual.
- No PCI-DSS assessment — card data is never captured, so the system is out of scope by design rather than by audit.
- AML and sanctions screening are stubbed as hooks, not implemented.
- Read replicas and a separate analytics path are not built; reporting queries hit the primary.
- Load and chaos testing are not performed, so throughput claims are untested.

## Repository presentation

Most reviewers spend two minutes on a repository. The README and the demo decide whether anyone reaches the code.

**Assume the reader knows none of your providers.** Lead with the provider-agnostic interface rather than any one implementation, and gloss every third-party name on first use in half a clause. A reviewer who meets an unexplained vendor name reads it as narrow experience; a reviewer who meets an interface with two implementations behind it reads the opposite. The ledger, idempotency and event design are provider-neutral — the README should make that visible without having to claim it.

**README structure, in order**

1. One-line description, then a screenshot of the ledger explorer.
2. Live demo link with test API keys, and the walkthrough video.
3. What it does, in four sentences.
4. Architecture diagram.
5. Quickstart: `docker compose --profile core up`, then the seed script.
6. The engineering highlights — ledger invariants, idempotency, outbox, ordering, audit chain — each two lines with a link to the code.
7. Trade-offs and failure modes.
8. Production gaps and what I would add next.
9. Testing, with the concurrency and idempotency tests named directly.

**Architecture Decision Records** in `/docs/adr`, numbered and dated. At minimum: ADR-001 ledger consistency boundary, ADR-002 Kafka over RabbitMQ, ADR-003 integer minor units, ADR-004 outbox via CDC, ADR-005 maker-checker scope.

**Runbooks** in `/docs/runbooks` for the five failure modes above: what the alert looks like, how to confirm, what to do, how to verify recovery.

**The demo must not be empty.** The seed script generates several merchants, a few hundred transactions across NGN, USD and EUR, payments from both provider adapters, some failed webhooks sitting in the DLT, and one reconciliation exception — so every screen shows something real across all three currencies.

**Walkthrough video, 3–5 minutes.** Make a sandbox payment and watch it appear live; open the ledger explorer and show the debits and credits; open the webhook inspector and show a retry ladder; open the reconciliation exception. Say what each one proves. Most applicants submit a README; a video of a working system is remembered.

**Description lines**

- *GitHub:* OmniLedger — an event-driven multi-currency ledger and payment orchestrator in TypeScript. Double-entry ledger, distributed idempotency, Kafka event streaming, tamper-evident audit logs.
- *CV:* Built OmniLedger, an event-driven ledger and payment orchestration platform (NestJS, PostgreSQL, Kafka, Redis) across nine services: immutable double-entry multi-currency ledger, distributed idempotency, CDC-based transactional outbox, HMAC-signed webhook delivery with retry ladder and DLT, hash-chained audit trail, and T+1 settlement reconciliation.

**Final check before sharing.** Clone the repository into an empty folder and follow your own quickstart. If it does not run first time, nothing else in this document matters.
