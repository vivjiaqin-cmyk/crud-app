# crud-app — inventory tracking on Cloudflare

A small inventory system: **items**, **locations**, and a **movement ledger** that
ties them together. Full CRUD over a REST API, plus a single-page browser UI —
all of it one Cloudflare Worker with a D1 database behind it.

TypeScript, [Hono](https://hono.dev) for routing, D1 for storage, and the UI
served from Cloudflare's edge as a static asset.

**Live:** <https://crud-app.crud-app.workers.dev>

```bash
npm install
npm run migrate:local     # create the tables in the local D1 file
npm run seed:local        # demo data: 3 locations, 12 items, a month of movements
npm run dev               # http://localhost:8787
```

Open <http://localhost:8787> for the UI, or `GET /api` for the endpoint list.

## The one design decision worth knowing

**Stock is never stored.** There is no `quantity` column on `items`. On-hand is
always `SUM(movements.quantity)`, so:

- Every number in the app can be traced to the rows that produced it.
- A stored counter and a ledger cannot drift apart, because there is no counter.
- Changing stock means *recording what happened* — a receipt, an issue, an
  adjustment, a transfer — not editing a field.

Two invariants live in the schema rather than in application code, where they
cannot be bypassed by a future caller:

- The sign of a movement is fixed by its kind (`CHECK` constraint): receipts and
  transfers-in add, issues and transfers-out subtract, adjustments go either way
  but never zero.
- A transfer is two rows sharing a `transfer_group`, written in one D1 `batch()`
  — a single transaction — so the total across locations cannot change and half a
  transfer cannot exist.

## How the no-negative-stock rule survives D1

D1 has no interactive transactions: a request cannot hold `BEGIN` open across an
`await`. So the balance check does not run as a separate read before the insert
— it runs *inside* it:

```sql
INSERT INTO movements (...)
SELECT ?, ?, ?, ?, ...
WHERE ? = 1                                    -- ALLOW_NEGATIVE_STOCK
   OR ? >= 0                                   -- inbound, nothing to check
   OR (SELECT COALESCE(SUM(quantity), 0)
       FROM movements
       WHERE item_id = ? AND location_id = ?) + ? >= 0
```

SQLite evaluates the sum and the insert together, so two concurrent issues cannot
both see enough stock. Zero rows affected means the guard refused the write, and
the route turns that into a 409 carrying the balance that caused it.

A transfer extends the same idea: the outbound row carries that guard, and the
inbound row inserts only `WHERE (SELECT COUNT(*) ... WHERE transfer_group = ?) = 1`
— it lands if and only if its other half did.

## Data model

| Table | Holds | Notes |
| --- | --- | --- |
| `items` | what you stock | unique SKU (case-insensitive), unit of issue, unit cost in integer cents, reorder point, archive flag |
| `locations` | where it sits | unique code, kind: `warehouse` / `store` / `transit` |
| `movements` | every change | signed quantity, kind, reference, note, `occurred_at` vs `created_at` |
| `stock_levels` | view | on-hand per item per location |

`occurred_at` is when the move happened in the real world; `created_at` is when
it was recorded. They differ whenever anyone enters yesterday's paperwork.

## API

Money is sent and returned in currency units (`"unitCost": 4.80`) and stored as
cents. Timestamps are ISO 8601.

### Items

| | |
| --- | --- |
| `GET /items` | `?q=` `?category=` `?lowStock` `?archived` `?sort=sku\|name\|onHand\|updated` `?offset=` `?limit=` |
| `POST /items` | `sku` and `name` required |
| `GET /items/categories` | distinct categories, for a filter dropdown |
| `GET /items/:id` | item + stock by location + last 20 movements |
| `PATCH /items/:id` | partial; `null` clears `description` / `category`; `archived` here |
| `DELETE /items/:id` | 409 while it has history — `?force=true` deletes the ledger too |
| `GET /items/:id/stock` | where one item is sitting |

Every list response carries `total` (matching rows) alongside `count` (rows
returned), so a client can page without guessing.

### Locations

`GET /locations?kind=` · `POST /locations` · `GET /locations/:id` (includes its
stock) · `PATCH /locations/:id` · `DELETE /locations/:id?force=true`

### Movements — the only way stock changes

```http
POST /movements
{ "itemId": 1, "locationId": 1, "kind": "receipt", "quantity": 60,
  "reference": "PO-1041", "note": "Opening stock", "occurredAt": "2026-08-01T08:00:00Z" }
```

`quantity` is a **positive magnitude** for `receipt` and `issue` — the kind
decides the sign — and a **signed delta** for `adjustment`, where going either
way is the entire point (`-2` writes off two units).

```http
POST /transfers
{ "itemId": 1, "fromLocationId": 1, "toLocationId": 2, "quantity": 10 }
```

`GET /movements?item=&location=&kind=&from=&to=&offset=&limit=` — newest first;
a bare `to=2026-08-31` includes that whole day.

`DELETE /movements/:id` is for fixing a mistyped entry: it takes both halves of a
transfer and refuses anything that would leave a negative balance. For a real
correction after the fact, post a reversing adjustment so the history still shows
what happened.

### Stock and health

`GET /stock?item=&location=&includeZero` · `GET /stock/low?limit=` (reorder list,
biggest shortfall first) · `GET /stock/summary` (dashboard tiles) ·
`GET /health` (queries D1; 503 if the database is unreachable)

## The UI

One `public/index.html`, no build step, no framework — it talks to the same REST
API as any other client. Three tabs:

- **Items** — search, category and low-stock filters, sorting, create/edit/delete,
  and a **Move** action that posts receipts, issues, adjustments and transfers.
- **Movements** — the ledger, filterable by item, location, kind and date range.
- **Locations** — cards showing what each one holds, with create/edit/delete.

It is uploaded as a static asset, so `GET /` is served from the edge without
invoking the Worker at all (`not_found_handling: "none"` sends every other path
through to the API).

## Deploying

Already deployed; `npm run deploy` ships a change. From scratch on another
account:

```bash
npx wrangler login                            # once, per machine
npx wrangler d1 create crud-app-db            # copy database_id into wrangler.jsonc
npm run migrate                               # apply migrations to the remote D1
npm run seed                                  # optional: demo data
npm run deploy
```

A newly created `*.workers.dev` subdomain takes a minute or two to get its TLS
certificate; until then the hostname resolves but the handshake fails.

`npm run tail` streams live logs. Observability is enabled in `wrangler.jsonc`,
so requests and `console.error` output are queryable from the dashboard.

## Configuration

Vars live in `wrangler.jsonc` and arrive per request as bindings.

| Binding | Default | |
| --- | --- | --- |
| `DB` | — | the D1 database |
| `ALLOW_NEGATIVE_STOCK` | `"false"` | permit issues that overdraw a location |
| `CORS_ORIGINS` | `"*"` | comma-separated allowlist |

## Scripts

| | |
| --- | --- |
| `npm run dev` | `wrangler dev` against the local D1 file |
| `npm run deploy` | deploy the Worker and upload the UI |
| `npm run migrate` / `migrate:local` | apply migrations, remote / local |
| `npm run seed` / `seed:local` | apply `seed.sql`, remote / local (**replaces all rows**) |
| `npm run seed:build` | regenerate `seed.sql` from `scripts/generate-seed.mjs` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run types` | regenerate `worker-configuration.d.ts` from the config |
| `npm run tail` | stream production logs |

## Layout

```
wrangler.jsonc         Worker, D1 binding, static assets, vars
migrations/            D1 schema, and the constraints holding the invariants
seed.sql               generated demo data (scripts/generate-seed.mjs)
src/
  index.ts             the Hono app: CORS, routes, error handling
  env.ts               bindings and the settings derived from them
  types.ts             the domain types
  errors.ts            HttpError
  query.ts body.ts     query-string and request-body validation
  db/
    d1.ts              query helpers, batch, and why there are no transactions
    constraints.ts     SQLite constraint errors to 4xx
  data/                items, locations, movements, stock — all SQL lives here
  routes/              HTTP shape only
public/index.html      the UI
```

## Not included

No authentication, and the API writes — put Cloudflare Access or an API token
check in front of it before pointing anything real at it.

On the Workers Free plan D1 allows 5 million rows read and 100,000 rows written
per day, with 5 GB of storage across the account — orders of magnitude more than
this schema will use. The ledger grows without bound by design: history is the
point, so plan on archiving old movements rather than deleting them if it ever
does get large.
