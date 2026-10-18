# Newtonite Challenge — Implementation, Demo and Interview Guide

Based on the supplied challenge advisory, the stated deadline is **Monday, 19 October 2026 at 10:00 AM**. Aim to submit by 9:30 AM. The project is an individual exercise; AI tools are permitted, but you must be able to explain and modify the code.

## 1. First-run checklist

1. Open the project root in VS Code.
2. Copy `.env.example` to `.env` if you want to customize local Compose settings.
3. Run `docker compose up --build`.
4. Wait for the database and API health checks to pass.
5. Open <http://localhost:5173> and sign in with `member@demo.local` / `password123`.
6. Create an item, inspect its activity, claim an unassigned item, and exercise the workflow.
7. Try `viewer@demo.local` and `payments-member@demo.local` to see read-only and cross-team boundaries.
8. Run `docker compose exec server npm test` with the stack up.

The UI is at <http://localhost:5173>; API readiness is <http://localhost:4000/api/health>. Use `docker compose down` to stop containers while preserving the database volume.

## 2. What the application implements

- React/Vite dashboard with server-side search, status, priority, type, team, assignee, and dashboard-view filters; bounded page navigation; item details; editing; comments; activity; and workflow actions.
- Express API, JWT login, seeded users, salted scrypt password hashes, team memberships, and server-enforced Viewer/Member/Lead/Admin permissions.
- PostgreSQL item schema, team-scoped reads, filtered listing, comments, due dates, activity timeline, and useful indexes.
- Workflow validation: `Open → In Progress → Awaiting Approval → Resolved → Closed`, with `In Progress → Open` and `Awaiting Approval → In Progress` return paths. Only a Lead for the item's team can approve it.
- Atomic conditional claims and optimistic version checks; conflicting or stale requests receive HTTP 409.
- Durable create idempotency keyed by user and operation, with payload fingerprint validation, original-response replay, and seven-day expiry.
- Transactional activity and PostgreSQL outbox insertion; leased `SKIP LOCKED` worker, retry/backoff, a five-attempt cap, dead-letter state, and an idempotent demonstration notification record.
- PostgreSQL integration tests for concurrency, idempotency, authorization, workflow, history/outbox, retries, pagination, and validation.

See [README.md](./README.md) for exact setup and test commands, demo account roles, endpoint overview, and known limitations. See [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md) for context, alternatives, trade-offs, and rationale.

## 3. Architecture explanation (60 seconds)

“The React client calls an Express API using a JWT. The API checks the user's role for each item's team and queries PostgreSQL with parameterized SQL. Item state, activity history, and an outbox job are written in a transaction. An item version prevents stale changes, while a conditional update serializes competing claims. A background worker safely retries outbox jobs; its sample effect is recorded in PostgreSQL rather than sent to an external notification provider.”

```text
React + Vite browser
        |
        | HTTP + JWT
        v
Express API — validation, team authorization, workflow
        |
        | PostgreSQL transactions
        v
PostgreSQL — users, memberships, items, comments, activity, outbox
        |
        | leased jobs
        v
Outbox worker — retry/backoff — idempotent notification records
```

## 4. Live discussion — sample answers

### How is authorization enforced?

“The server checks membership and role for the item's team on reads and writes. The client only controls what actions are convenient to show. An item in a different team is not returned, even if its ID is guessed.”

### How do two people avoid claiming one item?

“The server issues one conditional `UPDATE` requiring the item to be unassigned. PostgreSQL serializes the competing updates; exactly one succeeds and the other receives 409.”

### How does optimistic concurrency work?

“The client sends the version it loaded. The update succeeds only when that version still matches the database, and it increments the version as part of the same update. A stale caller gets 409 and the current authorized item so the UI can reload rather than overwrite.”

### What makes create retries idempotent?

“The caller sends an `Idempotency-Key`. The API stores the key, user, operation, normalized request hash, response, and expiry transactionally with the new work item. An equivalent retry returns the original response; using the key with a different payload returns 409.”

### Why an outbox?

“A queue publish after a database commit can be lost if the process stops between them. The API inserts an outbox job in the same transaction as the business mutation and activity event. A `SKIP LOCKED` worker leases jobs, retries with bounded backoff, and makes the demo notification idempotent.”

### Why PostgreSQL?

“Users, teams, memberships, work items, comments, activity, and jobs have relational integrity. PostgreSQL provides the transactions, conditional updates, unique constraints, and row-locking behavior this challenge needs.”

### What is intentionally not production-ready?

“Authentication uses seeded demo accounts, without SSO, MFA, password reset, account lockout, or rate limiting. Notifications are persisted locally rather than delivered externally. The worker runs beside the API, and pagination uses offsets. Deployment, metrics, and operational dead-letter tooling are not included.”

## 5. Suggested demo flow (3–5 minutes)

1. Sign in as `member@demo.local`; show team-scoped items and server-side filters.
2. Create an Urgent item with a team and due date; show its version and creation event.
3. Claim an unassigned item and move it to In Progress, then Awaiting Approval.
4. Sign in as `lead@demo.local` and approve it; explain that the API checks the Lead role.
5. Sign in as a Viewer and show that read works while mutations are forbidden.
6. Try a Payments account against an Operations item and show the not-found response.
7. Explain the version conflict, idempotency key, and outbox tests.

Do not claim the system is production-ready. The tests must run with PostgreSQL. In environments without a working Docker engine or local PostgreSQL, report that the database-backed tests and startup were not verified rather than treating them as passing.

## 6. Submission checklist

- [ ] Repository visibility is configured for the reviewer.
- [ ] README documents exact setup, tests, roles, and limitations.
- [ ] Engineering decisions explain alternatives and trade-offs.
- [ ] `.env.example` is present and contains placeholders, not production secrets.
- [ ] Frontend build and PostgreSQL integration tests have been run where the environment permits.
- [ ] All remaining unverified behavior is stated honestly.
- [ ] Optional demo recording and university submission form are completed.
- [ ] Submit by the stated deadline and retain a time buffer.
