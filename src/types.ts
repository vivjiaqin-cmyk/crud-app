/** Where stock physically sits. */
export type LocationKind = 'warehouse' | 'store' | 'transit';

/**
 * Why stock moved. The ledger stores a signed quantity and the database enforces
 * the sign that goes with each kind, so a receipt can never subtract.
 */
export type MovementKind = 'receipt' | 'issue' | 'adjustment' | 'transfer_in' | 'transfer_out';

export interface Item {
  id: number;
  /** Stock keeping unit, unique and case-insensitive, e.g. "WID-001". */
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  /** Unit of issue, e.g. "each", "box", "kg". */
  unit: string;
  /** Cost per unit in currency units, two decimals. Stored as integer cents. */
  unitCost: number;
  /** On-hand at or below this level counts as low stock. */
  reorderPoint: number;
  /** Archived items stay in the ledger but are hidden from the default list. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An item plus the stock figures derived from the ledger. */
export interface ItemWithStock extends Item {
  /** Sum of every movement for this item, across all locations. */
  onHand: number;
  /** Value of that stock at unit cost. */
  stockValue: number;
  /** True when onHand <= reorderPoint. */
  lowStock: boolean;
}

export interface Location {
  id: number;
  /** Short code, unique and case-insensitive, e.g. "WH-A". */
  code: string;
  name: string;
  kind: LocationKind;
  createdAt: string;
  updatedAt: string;
}

export interface Movement {
  id: number;
  itemId: number;
  locationId: number;
  kind: MovementKind;
  /** Signed delta: positive adds stock, negative removes it. */
  quantity: number;
  /** Caller's own document number — purchase order, work order, invoice. */
  reference: string | null;
  note: string | null;
  /** Set on both halves of a transfer so they can be found together. */
  transferGroup: string | null;
  /** When the move happened in the real world, which may predate the record. */
  occurredAt: string;
  createdAt: string;
}

/** A movement with the item and location names filled in, for list views. */
export interface MovementDetail extends Movement {
  sku: string;
  itemName: string;
  locationCode: string;
  locationName: string;
}

/** On-hand for one item at one location. */
export interface StockLevel {
  itemId: number;
  sku: string;
  itemName: string;
  locationId: number;
  locationCode: string;
  locationName: string;
  onHand: number;
  unit: string;
}
