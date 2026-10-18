# Engineering decisions

## 1. Optimistic concurrency and atomic claiming

**Context:** Multiple operators can edit the same item, and two people can act on an unassigned task at once. Silent last-write-wins behavior loses work, while an application-level read-then-write claim has a race.

**Alternatives considered:** Last-write-wins updates; pessimistic row locks for every edit; optimistic version checks; database conditional updates for claiming.

**Decision:** Updates and workflow transitions require the item `version`, match it in the SQL `UPDATE`, and increment it in that same statement. Claims use a conditional update requiring `assignee_id IS NULL`. A no-row update is a 409 conflict; stale responses include the current item when authorized.

**Benefits and trade-offs:** Normal edits do not hold locks while a user is thinking, and overlapping writes cannot silently overwrite. Clients must reconcile and retry after a conflict. A claim is serialized at the database and exactly one concurrent request can win.

**Why it fits:** The application has short, independent changes and low expected contention, with explicit challenge requirements for safe claims and stale-write protection.

## 2. Transactional activity history and the outbox

**Context:** Operators need an auditable timeline, and future side effects must not disappear between a database commit and a separate queue publish.

**Alternatives considered:** Best-effort event inserts after updates; publish directly to an external broker; use a PostgreSQL transactional outbox.

**Decision:** Item creation/update/claim/transition/comment mutations insert their activity event and corresponding outbox job on the same PostgreSQL connection and transaction. The outbox worker claims ready jobs in small batches with `FOR UPDATE SKIP LOCKED` and a renewable-by-expiry lease. It retries failures with exponential backoff, caps attempts at five, and marks exhausted jobs dead. Its demonstration notification effect uses a unique job ID so retries are idempotent.

**Benefits and trade-offs:** Business state, timeline, and pending asynchronous work commit or roll back together, with no added broker infrastructure. The worker's sample notification is a durable database record rather than a real external delivery, and an external effect would still need its own idempotency mechanism.

**Why it fits:** PostgreSQL is already required, offers transactions and safe concurrent claiming, and keeps local setup simple while demonstrating reliable asynchronous processing.

## 3. Team-scoped authorization and roles

**Context:** The dashboard's button visibility cannot protect APIs from direct requests or IDOR access.

**Alternatives considered:** Frontend-only role checks; global roles; resource-specific roles checked in shared server code.

**Decision:** Every item/detail/activity/comment query is constrained by team membership. Each mutation checks the caller's role for that item's team. Viewers are read-only; Members can create/edit basic fields, claim, comment, and take permitted non-approval transitions; Leads can also reassign and approve their team's items; Admins can reassign and perform the same ordinary mutations but do not approve. Approval is explicitly Lead-only. Items outside the caller's teams return 404.

**Benefits and trade-offs:** Authorization is enforced at the server and is meaningful per team, including for users with multiple memberships. Every new resource route must preserve the membership scope, and 404 intentionally does not distinguish missing from inaccessible items.

**Why it fits:** Operations and Payments need independent teams and role scopes; there is no need for an application-wide superuser bypass in this challenge.

## 4. Idempotency and asynchronous processing

**Context:** A lost response or client retry must not create a duplicate. Concurrent retries must not race, and a retry with different input must not replay an unrelated result.

**Alternatives considered:** Client-only double-click prevention; in-memory idempotency cache; a durable key with user/operation scope and request hash.

**Decision:** The create endpoint accepts `Idempotency-Key`. In a transaction, a unique `(key, user_id, scope)` record reserves the key; the request's normalized payload is hashed, and the original HTTP status/body is stored with the new item and activity. Equivalent retries receive that response, different payload reuse returns 409, and records expire after seven days. Outbox work shares the item transaction and is independently retryable.

**Benefits and trade-offs:** Retries are safe across restarts and concurrent calls without Redis. The policy currently applies to create requests, and expired records are removed lazily when a key is reused rather than by a scheduled cleanup task.

**Why it fits:** This fulfills the duplicate-create reliability requirement using the existing database only and provides a straightforward extension point for other mutation endpoints.

## 5. Pagination and indexes

**Context:** The browser must not load all work items, and operators commonly filter by team, status, priority, assignee, and recency.

**Alternatives considered:** Load-all client filtering; offset pagination; cursor pagination; introducing a search service.

**Decision:** The API applies authorization and filter predicates in PostgreSQL, returns a count and bounded page of results (maximum 100), and orders by `updated_at DESC, id DESC`. Indexes cover team/status/priority with update time, assignee with update time, unassigned team/priority work, and per-item activity/comments.

**Benefits and trade-offs:** Common queries remain bounded and the frontend's filters are server-side. Offset pagination is simple to explain and adequate for seeded demo volumes, but very large datasets may pay for deep offsets and can shift between pages under concurrent updates.

**Why it fits:** The current application needs clear filters and working pagination with modest data sizes; cursor pagination or full-text indexing can be added when measured usage justifies the complexity.
