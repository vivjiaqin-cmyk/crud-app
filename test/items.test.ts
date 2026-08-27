import { beforeEach, describe, expect, it } from 'vitest';
import { fixtures, move, request, type Fixtures } from './helpers';

let ids: Fixtures;

beforeEach(async () => {
  ids = await fixtures();
});

describe('GET /items', () => {
  it('returns every item with its ledger-derived stock', async () => {
    const { status, body } = await request('/items');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.count).toBe(3);
    expect(body.items[0]).toMatchObject({ sku: 'BLT-M6', onHand: 0, stockValue: 0, lowStock: true });
  });

  it('reflects movements in onHand, stockValue and lowStock', async () => {
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'receipt', quantity: 25 });

    const { body } = await request(`/items/${ids.bolts}`);
    expect(body.onHand).toBe(25);
    // 25 boxes at 4.80 each, from unit_cost_cents so no float drift.
    expect(body.stockValue).toBe(120);
    expect(body.lowStock).toBe(false);
  });

  it('searches sku, name, description and category', async () => {
    const bySku = await request('/items?q=BLT');
    expect(bySku.body.items.map((i: any) => i.sku)).toEqual(['BLT-M6']);

    const byName = await request('/items?q=patch');
    expect(byName.body.items.map((i: any) => i.sku)).toEqual(['CBL-CAT6']);

    const byDescription = await request('/items?q=zinc');
    expect(byDescription.body.items.map((i: any) => i.sku)).toEqual(['BLT-M6']);

    const byCategory = await request('/items?q=cabling');
    expect(byCategory.body.items.map((i: any) => i.sku)).toEqual(['CBL-CAT6']);
  });

  it('treats % and _ in a search as literal characters', async () => {
    const percent = await request(`/items?q=${encodeURIComponent('50%')}`);
    expect(percent.body.items.map((i: any) => i.sku)).toEqual(['SPR-50%']);

    // A bare wildcard must not match everything.
    const underscore = await request(`/items?q=${encodeURIComponent('_')}`);
    expect(underscore.body.total).toBe(0);
  });

  it('filters by category, case-insensitively', async () => {
    const { body } = await request('/items?category=fasteners');
    expect(body.total).toBe(1);
    expect(body.items[0].sku).toBe('BLT-M6');
  });

  it('filters to items at or below their reorder point', async () => {
    // Reorder point 10; 10 on hand is "at", which counts as low.
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'receipt', quantity: 10 });
    await move({ itemId: ids.cable, locationId: ids.warehouse, kind: 'receipt', quantity: 99 });

    const { body } = await request('/items?lowStock');
    expect(body.items.map((i: any) => i.sku).sort()).toEqual(['BLT-M6', 'SPR-50%']);
  });

  it('hides archived items unless asked', async () => {
    await request(`/items/${ids.spare}`, { method: 'PATCH', body: { archived: true } });

    const hidden = await request('/items');
    expect(hidden.body.total).toBe(2);

    const shown = await request('/items?archived');
    expect(shown.body.total).toBe(3);
  });

  it('sorts by sku, name and on-hand', async () => {
    await move({ itemId: ids.cable, locationId: ids.warehouse, kind: 'receipt', quantity: 5 });

    const bySku = await request('/items?sort=sku');
    expect(bySku.body.items.map((i: any) => i.sku)).toEqual(['BLT-M6', 'CBL-CAT6', 'SPR-50%']);

    const byName = await request('/items?sort=name');
    expect(byName.body.items.map((i: any) => i.name[0])).toEqual(['C', 'H', 'S']);

    // Lowest stock first is the point of this sort: it surfaces what to reorder.
    const byStock = await request('/items?sort=onHand');
    expect(byStock.body.items.map((i: any) => i.onHand)).toEqual([0, 0, 5]);
  });

  it('accepts the sort name in any case', async () => {
    const { status } = await request('/items?sort=onhand');
    expect(status).toBe(200);
  });

  it('pages with limit and offset, reporting the unpaged total', async () => {
    const page = await request('/items?limit=2&offset=1&sort=sku');
    expect(page.body).toMatchObject({ total: 3, count: 2 });
    expect(page.body.items.map((i: any) => i.sku)).toEqual(['CBL-CAT6', 'SPR-50%']);
  });

  it('rejects filters it does not understand', async () => {
    const sort = await request('/items?sort=colour');
    expect(sort.status).toBe(400);
    expect(sort.body.error).toMatch(/sort must be one of/);

    const limit = await request('/items?limit=0');
    expect(limit.status).toBe(400);

    const tooBig = await request('/items?limit=500');
    expect(tooBig.status).toBe(400);

    const flag = await request('/items?lowStock=maybe');
    expect(flag.status).toBe(400);
  });
});

describe('GET /items/categories', () => {
  it('lists distinct categories of unarchived items, sorted', async () => {
    const { body } = await request('/items/categories');
    expect(body.categories).toEqual(['Cabling', 'Fasteners']);
  });

  it('is not shadowed by the /items/:id route', async () => {
    const { status } = await request('/items/categories');
    expect(status).toBe(200);
  });
});

describe('GET /items/:id', () => {
  it('includes where the stock sits and the recent ledger', async () => {
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'receipt', quantity: 8 });
    await move({ itemId: ids.bolts, locationId: ids.store, kind: 'receipt', quantity: 2 });

    const { body } = await request(`/items/${ids.bolts}`);
    expect(body.onHand).toBe(10);
    expect(body.byLocation.map((l: any) => [l.locationCode, l.onHand])).toEqual([
      ['ST-1', 2],
      ['WH-A', 8],
    ]);
    expect(body.recentMovements).toHaveLength(2);
  });

  it('404s an unknown id and 400s a non-numeric one', async () => {
    expect((await request('/items/999')).status).toBe(404);

    const bad = await request('/items/abc');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/positive integer/);
  });
});

describe('POST /items', () => {
  it('creates an item at zero stock and points at it', async () => {
    const { status, body, headers } = await request('/items', {
      method: 'POST',
      body: { sku: 'NEW-1', name: 'New thing', category: 'Misc', unitCost: 3.25, reorderPoint: 4 },
    });

    expect(status).toBe(201);
    expect(headers.get('location')).toBe(`/items/${body.id}`);
    expect(body).toMatchObject({ sku: 'NEW-1', unitCost: 3.25, reorderPoint: 4, onHand: 0 });
  });

  it('defaults unit, cost and reorder point', async () => {
    const { body } = await request('/items', { method: 'POST', body: { sku: 'D-1', name: 'Default' } });
    expect(body).toMatchObject({ unit: 'each', unitCost: 0, reorderPoint: 0, archived: false });
    expect(body.description).toBeNull();
    expect(body.category).toBeNull();
  });

  it('trims whitespace and treats an empty optional as absent', async () => {
    const { body } = await request('/items', {
      method: 'POST',
      body: { sku: '  T-1  ', name: '  Trimmed  ', category: '   ' },
    });
    expect(body.sku).toBe('T-1');
    expect(body.name).toBe('Trimmed');
    expect(body.category).toBeNull();
  });

  it('refuses a duplicate SKU regardless of case', async () => {
    const { status, body } = await request('/items', {
      method: 'POST',
      body: { sku: 'blt-m6', name: 'Clashing' },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/);
  });

  it('requires sku and name', async () => {
    expect((await request('/items', { method: 'POST', body: { name: 'No sku' } })).status).toBe(400);
    expect((await request('/items', { method: 'POST', body: { sku: 'NO-NAME' } })).status).toBe(400);
    expect((await request('/items', { method: 'POST', body: { sku: '  ', name: 'Blank' } })).status).toBe(400);
  });

  it('names a misspelled field instead of ignoring it', async () => {
    const { status, body } = await request('/items', {
      method: 'POST',
      body: { sku: 'TYPO-1', name: 'Typo', reorderpoint: 3 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown field: reorderpoint/);
  });

  it('rejects money it cannot store exactly, and impossible numbers', async () => {
    const thirds = await request('/items', {
      method: 'POST',
      body: { sku: 'M-1', name: 'Money', unitCost: 1.234 },
    });
    expect(thirds.status).toBe(400);
    expect(thirds.body.error).toMatch(/2 decimal places/);

    const negativeCost = await request('/items', {
      method: 'POST',
      body: { sku: 'M-2', name: 'Money', unitCost: -1 },
    });
    expect(negativeCost.status).toBe(400);

    const negativeReorder = await request('/items', {
      method: 'POST',
      body: { sku: 'M-3', name: 'Money', reorderPoint: -1 },
    });
    expect(negativeReorder.status).toBe(400);

    const fractionalReorder = await request('/items', {
      method: 'POST',
      body: { sku: 'M-4', name: 'Money', reorderPoint: 1.5 },
    });
    expect(fractionalReorder.status).toBe(400);
  });

  it('rejects a body that is not an object', async () => {
    expect((await request('/items', { method: 'POST', raw: '[]' })).status).toBe(400);
    expect((await request('/items', { method: 'POST', raw: '"nope"' })).status).toBe(400);
  });

  // There is deliberately no quantity field: stock arrives through the ledger.
  it('has no way to set stock directly', async () => {
    const { status, body } = await request('/items', {
      method: 'POST',
      body: { sku: 'Q-1', name: 'Quantity', quantity: 50 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown field: quantity/);
  });
});

describe('PATCH /items/:id', () => {
  it('changes only the fields present', async () => {
    const { body } = await request(`/items/${ids.bolts}`, {
      method: 'PATCH',
      body: { reorderPoint: 25 },
    });
    expect(body).toMatchObject({ sku: 'BLT-M6', name: 'Hex bolt M6', reorderPoint: 25 });
    expect(body.description).toBe('Zinc plated');
  });

  it('clears description and category with null', async () => {
    const { body } = await request(`/items/${ids.bolts}`, {
      method: 'PATCH',
      body: { description: null, category: null },
    });
    expect(body.description).toBeNull();
    expect(body.category).toBeNull();
  });

  it('archives and restores', async () => {
    const archived = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: { archived: true } });
    expect(archived.body.archived).toBe(true);

    const restored = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: { archived: false } });
    expect(restored.body.archived).toBe(false);
  });

  it('moves updatedAt but leaves createdAt alone', async () => {
    const before = await request(`/items/${ids.bolts}`);
    const after = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: { name: 'Renamed' } });

    expect(after.body.createdAt).toBe(before.body.createdAt);
    expect(Date.parse(after.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.body.updatedAt));
  });

  it('allows a no-op SKU change on the same item but blocks a clash', async () => {
    const same = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: { sku: 'BLT-M6' } });
    expect(same.status).toBe(200);

    const clash = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: { sku: 'CBL-CAT6' } });
    expect(clash.status).toBe(409);
  });

  it('rejects an empty patch rather than silently doing nothing', async () => {
    const { status, body } = await request(`/items/${ids.bolts}`, { method: 'PATCH', body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/No fields to update/);
  });

  it('404s an unknown item', async () => {
    const { status } = await request('/items/999', { method: 'PATCH', body: { name: 'Ghost' } });
    expect(status).toBe(404);
  });
});

describe('DELETE /items/:id', () => {
  it('deletes an item with no history', async () => {
    const { status, body } = await request(`/items/${ids.spare}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: { sku: 'SPR-50%' }, movementsDeleted: 0 });
    expect((await request(`/items/${ids.spare}`)).status).toBe(404);
  });

  it('refuses to destroy history, and names archiving as the alternative', async () => {
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'receipt', quantity: 5 });

    const { status, body } = await request(`/items/${ids.bolts}`, { method: 'DELETE' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/1 movement\b/);
    expect(body.error).toMatch(/Archive it/);

    // Still there.
    expect((await request(`/items/${ids.bolts}`)).status).toBe(200);
  });

  it('takes the ledger with it when forced, and reports how much', async () => {
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'receipt', quantity: 5 });
    await move({ itemId: ids.bolts, locationId: ids.warehouse, kind: 'issue', quantity: 2 });

    const { status, body } = await request(`/items/${ids.bolts}?force=true`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.movementsDeleted).toBe(2);

    const ledger = await request(`/movements?item=${ids.bolts}`);
    expect(ledger.body.total).toBe(0);
  });

  it('404s an unknown item', async () => {
    expect((await request('/items/999', { method: 'DELETE' })).status).toBe(404);
  });
});
