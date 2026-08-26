import { Router } from 'express';
import { ABSENT, asObject, enumField, optionalString, rejectUnknown, requiredString } from '../body.js';
import {
  LOCATION_KINDS,
  countMovementsForLocation,
  createLocation,
  deleteLocation,
  findLocationByCode,
  listLocations,
  requireLocation,
  updateLocation,
  type LocationPatch,
} from '../data/locations.js';
import { listStock } from '../data/stock.js';
import { guard } from '../db/constraints.js';
import { HttpError } from '../middleware/errors.js';
import { boolParam, enumParam, idParam } from '../query.js';

export const locationsRouter: Router = Router();

const FIELDS = ['code', 'name', 'kind'] as const;
const CODE_TAKEN = { code: 'A location with that code already exists' };

/** GET /locations?kind=warehouse|store|transit */
locationsRouter.get('/locations', (req, res) => {
  const kind = enumParam(req.query['kind'], 'kind', LOCATION_KINDS);
  const locations = listLocations(kind);
  res.json({ count: locations.length, locations });
});

/** GET /locations/:id — the location and everything currently in it. */
locationsRouter.get('/locations/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const location = requireLocation(id);
  res.json({ ...location, stock: listStock({ locationId: id, includeZero: false }) });
});

/** POST /locations */
locationsRouter.post('/locations', (req, res) => {
  const body = asObject(req.body);
  rejectUnknown(body, FIELDS);

  const code = requiredString(body, 'code', 32);
  if (findLocationByCode(code) !== undefined) {
    throw new HttpError(409, `A location with code "${code}" already exists`);
  }

  const kind = enumField(body, 'kind', LOCATION_KINDS);
  const location = guard(CODE_TAKEN, () =>
    createLocation({
      code,
      name: requiredString(body, 'name'),
      kind: kind === ABSENT ? 'warehouse' : kind,
    }),
  );

  res.status(201).location(`/locations/${location.id}`).json(location);
});

/** PATCH /locations/:id */
locationsRouter.patch('/locations/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const body = asObject(req.body);
  rejectUnknown(body, FIELDS);

  const patch: LocationPatch = {};

  const code = optionalString(body, 'code', 32);
  if (code !== ABSENT) {
    const clash = findLocationByCode(code);
    if (clash !== undefined && clash.id !== id) {
      throw new HttpError(409, `A location with code "${code}" already exists`);
    }
    patch.code = code;
  }

  const name = optionalString(body, 'name');
  if (name !== ABSENT) patch.name = name;

  const kind = enumField(body, 'kind', LOCATION_KINDS);
  if (kind !== ABSENT) patch.kind = kind;

  res.json(guard(CODE_TAKEN, () => updateLocation(id, patch)));
});

/**
 * DELETE /locations/:id
 *
 * Refuses while stock or history is attached. Locations have no archive flag —
 * an empty location is cheap to keep and a deleted one takes its movements with
 * it, so ?force=true is the only way through and it says what it will destroy.
 */
locationsRouter.delete('/locations/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const force = boolParam(req.query['force'], 'force');
  const location = requireLocation(id);
  const history = countMovementsForLocation(id);

  if (history > 0 && !force) {
    throw new HttpError(
      409,
      `Location ${location.code} has ${history} movement${history === 1 ? '' : 's'} ` +
        `and ${location.unitsOnHand} unit${location.unitsOnHand === 1 ? '' : 's'} on hand. ` +
        'Transfer the stock out first, or repeat with ?force=true to delete the history too.',
    );
  }

  deleteLocation(id);
  res.json({ deleted: { id, code: location.code }, movementsDeleted: force ? history : 0 });
});
