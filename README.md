# crud-app — inventory tracking

A small inventory system: **items**, **locations**, and a **movement ledger** that
ties them together. Full CRUD over a REST API, plus a single-page browser UI
served from the same process.

TypeScript, Express 5, and SQLite through Node's built-in `node:sqlite` — one
runtime dependency (`express`) and no database to install.

```bash
npm install
npm run seed     # demo data: 3 locations, 12 items, a month of movements
npm run dev      # http://localhost:3100
```

Open <http://localhost:3100> for the UI, or `GET /api` for the endpoint list.

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
- A transfer is two rows sharing a `transfer_group`, written in one transaction,
  so the total across locations cannot change and half a transfer cannot exist.

On top of that the API refuses any movement that would drive a location's balance
negative (`ALLOW_NEGATIVE_STOCK=true` if your process really books issues before
receipts land).

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
`GET /health` (probes the database, 503 if it is unreachable)

## The UI

One `public/index.html`, no build step, no framework — it talks to the same REST
API as any other client. Three tabs:

- **Items** — search, category and low-stock filters, sorting, create/edit/delete,
  and a **Move** action that posts receipts, issues, adjustments and transfers.
- **Movements** — the ledger, filterable by item, location, kind and date range.
- **Locations** — cards showing what each one holds, with create/edit/delete.

Low-stock lines are flagged in the table and counted in the header tiles.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3100` | |
| `DB_FILE` | `data/inventory.db` | `:memory:` for a throwaway database |
| `ALLOW_NEGATIVE_STOCK` | `false` | permit issues that overdraw a location |
| `CORS_ORIGINS` | `*` | comma-separated allowlist |

## Scripts

| | |
| --- | --- |
| `npm run dev` | watch mode via tsx |
| `npm run build` / `npm start` | compile to `dist/`, run compiled |
| `npm run seed` | demo data; `-- --force` wipes first |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/
  index.ts            startup and shutdown
  app.ts              routes, middleware, static UI
  config.ts           environment
  types.ts            the domain types
  query.ts body.ts    query-string and request-body validation
  db/
    client.ts         the SQLite handle, transactions, row helpers
    schema.ts         DDL and the constraints that hold the invariants
    constraints.ts    SQLite constraint errors to 4xx
    seed.ts           demo data
  data/               items, locations, movements, stock — all SQL lives here
  routes/             HTTP shape only
public/index.html     the UI
```

## Not included

No authentication, and the API writes — put it behind auth before exposing it
beyond a trusted network. Single process only: `node:sqlite` is synchronous, so
concurrent reads and writes are serialised inside one Node process, which is
exactly why the stock checks are safe without extra locking.
