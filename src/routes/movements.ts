import { Router } from 'express';
import { ABSENT, asObject, enumField, integer, nullableString, rejectUnknown, timestamp } from '../body.js';
import { requireItem } from '../data/items.js';
import { requireLocation } from '../data/locations.js';
import {
  MOVEMENT_KINDS,
  POSTABLE_KINDS,
  createMovement,
  deleteMovement,
  listMovements,
  requireMovement,
  transferStock,
} from '../data/movements.js';
import { HttpError } from '../middleware/errors.js';
import { enumParam, idParam, intParam, optionalIdParam, optionalString } from '../query.js';

export const movementsRouter: Router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUANTITY = 1_000_000;

const MOVEMENT_FIELDS = [
  'itemId',
  'locationId',
  'kind',
  'quantity',
  'reference',
  'note',
  'occurredAt',
] as const;

const TRANSFER_FIELDS = [
  'itemId',
  'fromLocationId',
  'toLocationId',
  'quantity',
  'reference',
  'note',
  'occurredAt',
] as const;

/**
 * GET /movements
 *   ?item=12&location=3&kind=issue
 *   ?from=2026-08-01&to=2026-08-31   inclusive bounds on occurredAt
 *   ?offset=0&limit=50
 *
 * Newest first. This is the audit trail, so nothing is ever rewritten here —
 * corrections are new rows.
 */
movementsRouter.get('/movements', (req, res) => {
  const itemId = optionalIdParam(req.query['item'], 'item');
  const locationId = optionalIdParam(req.query['location'], 'location');
  const kind = enumParam(req.query['kind'], 'kind', MOVEMENT_KINDS);
  const from = optionalString(req.query['from'], 'from');
  const to = optionalString(req.query['to'], 'to');

  const { total, movements } = listMovements({
    ...(itemId !== undefined ? { itemId } : {}),
    ...(locationId !== undefined ? { locationId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(from !== undefined ? { from } : {}),
    // A bare date as an upper bound should include that whole day, not stop at
    // its midnight: "to=2026-08-31" means through the 31st.
    ...(to !== undefined ? { to: to.length === 10 ? `${to}T23:59:59.999Z` : to } : {}),
    offset: intParam(req.query['offset'], 'offset', 0, 0, 1_000_000),
    limit: intParam(req.query['limit'], 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
  });

  res.json({ total, count: movements.length, movements });
});

/** GET /movements/:id */
movementsRouter.get('/movements/:id', (req, res) => {
  res.json(requireMovement(idParam(req.params['id'], 'id')));
});

/**
 * POST /movements
 *
 * The one way stock changes. `quantity` is a positive magnitude for a receipt or
 * an issue — the kind decides the sign — and a signed delta for an adjustment,
 * where the whole point is that it can go either way.
 */
movementsRouter.post('/movements', (req, res) => {
  const body = asObject(req.body);
  rejectUnknown(body, MOVEMENT_FIELDS);

  const itemId = integer(body, 'itemId', 1, Number.MAX_SAFE_INTEGER);
  const locationId = integer(body, 'locationId', 1, Number.MAX_SAFE_INTEGER);
  const kind = enumField(body, 'kind', POSTABLE_KINDS);
  const quantity = integer(body, 'quantity', -MAX_QUANTITY, MAX_QUANTITY);

  if (itemId === ABSENT) throw new HttpError(400, 'itemId is required');
  if (locationId === ABSENT) throw new HttpError(400, 'locationId is required');
  if (kind === ABSENT) throw new HttpError(400, `kind is required: ${POSTABLE_KINDS.join(', ')}`);
  if (quantity === ABSENT) throw new HttpError(400, 'quantity is required');

  // 404 on the way in, rather than a foreign-key error on the way out.
  requireItem(itemId);
  requireLocation(locationId);

  const reference = nullableString(body, 'reference', 80);
  const note = nullableString(body, 'note');

  const movement = createMovement({
    itemId,
    locationId,
    kind,
    quantity,
    reference: reference === ABSENT ? null : reference,
    note: note === ABSENT ? null : note,
    occurredAt: timestamp(body, 'occurredAt'),
  });

  res.status(201).location(`/movements/${movement.id}`).json(movement);
});

/**
 * DELETE /movements/:id
 *
 * Here for correcting a mistyped entry. Both halves of a transfer go together,
 * and anything that would leave a negative balance is refused — for a real
 * correction after the fact, post a reversing adjustment instead so the history
 * still shows what happened.
 */
movementsRouter.delete('/movements/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const movement = requireMovement(id);
  const deleted = deleteMovement(id);

  res.json({
    deleted,
    movement: { id: movement.id, kind: movement.kind, quantity: movement.quantity },
    transferGroup: movement.transferGroup,
  });
});

/**
 * POST /transfers
 *
 * Moves stock between locations. Writes a transfer_out and a transfer_in sharing
 * a transfer_group in one transaction, so the company-wide total cannot change.
 */
movementsRouter.post('/transfers', (req, res) => {
  const body = asObject(req.body);
  rejectUnknown(body, TRANSFER_FIELDS);

  const itemId = integer(body, 'itemId', 1, Number.MAX_SAFE_INTEGER);
  const fromLocationId = integer(body, 'fromLocationId', 1, Number.MAX_SAFE_INTEGER);
  const toLocationId = integer(body, 'toLocationId', 1, Number.MAX_SAFE_INTEGER);
  const quantity = integer(body, 'quantity', 1, MAX_QUANTITY);

  if (itemId === ABSENT) throw new HttpError(400, 'itemId is required');
  if (fromLocationId === ABSENT) throw new HttpError(400, 'fromLocationId is required');
  if (toLocationId === ABSENT) throw new HttpError(400, 'toLocationId is required');
  if (quantity === ABSENT) throw new HttpError(400, 'quantity is required');

  requireItem(itemId);
  requireLocation(fromLocationId, 'fromLocationId');
  requireLocation(toLocationId, 'toLocationId');

  const reference = nullableString(body, 'reference', 80);
  const note = nullableString(body, 'note');

  const transfer = transferStock({
    itemId,
    fromLocationId,
    toLocationId,
    quantity,
    reference: reference === ABSENT ? null : reference,
    note: note === ABSENT ? null : note,
    occurredAt: timestamp(body, 'occurredAt'),
  });

  res.status(201).json(transfer);
});
