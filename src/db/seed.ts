import { config } from '../config.js';
import { createItem } from '../data/items.js';
import { createLocation } from '../data/locations.js';
import { createMovement, transferStock } from '../data/movements.js';
import { closeDb, db, one, transaction } from './client.js';

/**
 * Demo data: three locations, a dozen items, and a month of movements, arranged
 * so the dashboard, the low-stock list and the ledger all have something to
 * show — five lines end up at or under their reorder point.
 *
 *   npm run seed              fills an empty database, refuses a populated one
 *   npm run seed -- --force   wipes first
 *
 * Quantities are spelled out per item rather than generated, because the seed
 * has to respect the same no-negative-stock rule as the API: an issue larger
 * than what is on hand would be refused here exactly as it would in a request.
 */

const LOCATIONS = [
  { code: 'WH-A', name: 'Jurong Warehouse', kind: 'warehouse' as const },
  { code: 'WH-B', name: 'Changi Overflow', kind: 'warehouse' as const },
  { code: 'ST-1', name: 'Orchard Shopfront', kind: 'store' as const },
];

/** `opening` is received once; `issue` goes out four times over the month. */
const ITEMS = [
  { sku: 'BLT-M6-30',    name: 'Hex bolt M6 x 30mm',      category: 'Fasteners',   unit: 'box of 100', unitCostCents: 480,  reorderPoint: 20, opening: 60,  issue: 10 },
  { sku: 'NUT-M6',       name: 'Hex nut M6',              category: 'Fasteners',   unit: 'box of 200', unitCostCents: 320,  reorderPoint: 20, opening: 70,  issue: 12 },
  { sku: 'WSH-M6',       name: 'Flat washer M6',          category: 'Fasteners',   unit: 'box of 500', unitCostCents: 260,  reorderPoint: 10, opening: 50,  issue: 10 },
  { sku: 'CBL-CAT6-05',  name: 'Cat6 patch cable 0.5m',   category: 'Cabling',     unit: 'each',       unitCostCents: 190,  reorderPoint: 40, opening: 120, issue: 20 },
  { sku: 'CBL-CAT6-30',  name: 'Cat6 patch cable 3m',     category: 'Cabling',     unit: 'each',       unitCostCents: 420,  reorderPoint: 40, opening: 140, issue: 22 },
  { sku: 'CBL-TIE-200',  name: 'Cable tie 200mm',         category: 'Cabling',     unit: 'bag of 100', unitCostCents: 350,  reorderPoint: 15, opening: 60,  issue: 10 },
  { sku: 'PSU-12V-5A',   name: 'Power supply 12V 5A',     category: 'Power',       unit: 'each',       unitCostCents: 2150, reorderPoint: 8,  opening: 30,  issue: 5 },
  { sku: 'BAT-18650',    name: 'Li-ion cell 18650',       category: 'Power',       unit: 'each',       unitCostCents: 780,  reorderPoint: 24, opening: 90,  issue: 15 },
  { sku: 'FUS-5A',       name: 'Blade fuse 5A',           category: 'Power',       unit: 'pack of 10', unitCostCents: 240,  reorderPoint: 12, opening: 48,  issue: 9 },
  { sku: 'ENC-IP65-S',   name: 'Enclosure IP65 small',    category: 'Enclosures',  unit: 'each',       unitCostCents: 1640, reorderPoint: 6,  opening: 20,  issue: 4 },
  { sku: 'ENC-IP65-L',   name: 'Enclosure IP65 large',    category: 'Enclosures',  unit: 'each',       unitCostCents: 3120, reorderPoint: 4,  opening: 12,  issue: 3 },
  { sku: 'LBL-THERM-50', name: 'Thermal label roll 50mm', category: 'Consumables', unit: 'roll',       unitCostCents: 590,  reorderPoint: 10, opening: 40,  issue: 8 },
];

/** Restocks that landed mid-month: slow lines, ordered in bulk. */
const RESTOCKS = [
  { sku: 'ENC-IP65-S', quantity: 25 },
  { sku: 'ENC-IP65-L', quantity: 25 },
];

/** Warehouse to shopfront, as transfers so the ledger has paired rows. */
const STORE_TRANSFERS = [
  { sku: 'CBL-CAT6-05', quantity: 12 },
  { sku: 'CBL-CAT6-30', quantity: 12 },
  { sku: 'BAT-18650', quantity: 12 },
  { sku: 'FUS-5A', quantity: 6 },
];

const ISSUE_DAYS = [21, 14, 7, 2];

/** Days back as an ISO timestamp, so the ledger spans a believable month. */
function daysAgo(days: number, hour: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function wipe(): void {
  // Movements first: the foreign keys would cascade, but being explicit keeps
  // this readable as "empty every table".
  transaction(() => {
    db().exec('DELETE FROM movements');
    db().exec('DELETE FROM locations');
    db().exec('DELETE FROM items');
  });
}

function seed(): void {
  const locations = LOCATIONS.map(createLocation);
  const items = ITEMS.map(({ opening, issue, ...item }) => ({
    ...createItem({ ...item, description: null }),
    opening,
    issue,
  }));

  const locationId = (code: string): number => {
    const found = locations.find((location) => location.code === code);
    if (found === undefined) throw new Error(`seed location ${code} is missing`);
    return found.id;
  };
  const itemId = (sku: string): number => {
    const found = items.find((item) => item.sku === sku);
    if (found === undefined) throw new Error(`seed item ${sku} is missing`);
    return found.id;
  };

  const warehouse = locationId('WH-A');
  const overflow = locationId('WH-B');
  const store = locationId('ST-1');
  let movements = 0;

  // Opening stock, four weeks back.
  for (const item of items) {
    createMovement({
      itemId: item.id,
      locationId: warehouse,
      kind: 'receipt',
      quantity: item.opening,
      reference: 'PO-1041',
      note: 'Opening stock',
      occurredAt: daysAgo(28, 8),
    });
    movements += 1;
  }

  // A steady trickle out of the warehouse against work orders.
  items.forEach((item, index) => {
    ISSUE_DAYS.forEach((day, round) => {
      createMovement({
        itemId: item.id,
        locationId: warehouse,
        kind: 'issue',
        quantity: item.issue,
        reference: `WO-${2200 + index * 4 + round}`,
        note: null,
        occurredAt: daysAgo(day, 11),
      });
      movements += 1;
    });
  });

  for (const restock of RESTOCKS) {
    createMovement({
      itemId: itemId(restock.sku),
      locationId: warehouse,
      kind: 'receipt',
      quantity: restock.quantity,
      reference: 'PO-1088',
      note: 'Replenishment',
      occurredAt: daysAgo(10, 10),
    });
    movements += 1;
  }

  for (const transfer of STORE_TRANSFERS) {
    transferStock({
      itemId: itemId(transfer.sku),
      fromLocationId: warehouse,
      toLocationId: store,
      quantity: transfer.quantity,
      reference: 'TR-004',
      note: 'Weekly store replenishment',
      occurredAt: daysAgo(6, 14),
    });
    movements += 2;
  }

  transferStock({
    itemId: itemId('BLT-M6-30'),
    fromLocationId: warehouse,
    toLocationId: overflow,
    quantity: 10,
    reference: 'TR-005',
    note: 'Freeing rack space in Jurong',
    occurredAt: daysAgo(4, 15),
  });
  movements += 2;

  // A stocktake write-down: two boxes found damaged. This is what adjustments
  // are for — the stock is gone, but no customer or work order took it.
  createMovement({
    itemId: itemId('BLT-M6-30'),
    locationId: warehouse,
    kind: 'adjustment',
    quantity: -2,
    reference: 'STK-2026-08',
    note: 'Water damage found during stocktake',
    occurredAt: daysAgo(1, 16),
  });
  movements += 1;

  console.log(
    `seeded ${locations.length} locations, ${items.length} items, ${movements} movements into ${config.dbFile}`,
  );
}

const force = process.argv.includes('--force');
const existing = one<{ total: number }>('SELECT COUNT(*) AS total FROM items')?.total ?? 0;

if (existing > 0 && !force) {
  console.error(
    `${config.dbFile} already holds ${existing} items. Re-run with --force to wipe and reseed.`,
  );
  closeDb();
  process.exit(1);
}

if (existing > 0) wipe();
seed();
closeDb();
