/**
 * The order somebody has arranged their Dashboard tiles into — PRD 1.1.
 *
 * ## Why this is per browser rather than stored on the server
 *
 * It is a view preference, and this product already keeps that class of thing in `localStorage`:
 * the active workspace, the theme, whether the sidebar is collapsed. A server-side preference
 * would follow somebody between devices, which is better — and it would be a new table, a new
 * endpoint and a new thing to keep in step with the permission model, for the question "which
 * order do I like my tiles in". That is a trade worth making deliberately rather than by accident,
 * and it is not made here.
 *
 * ## Why it is keyed by company
 *
 * One person can belong to more than one. The tiles they are shown differ per company, because
 * the server only sends the areas they may see there, so one shared order would be an order over
 * a set of tiles that does not exist in the other company.
 *
 * ## What it is not
 *
 * Not a permission, and not a filter. A tile missing from the stored order still appears — it is
 * appended in the server's own order — and a tile in the stored order that the server did not
 * send is ignored. The server decides what somebody may see; this only decides what sits where.
 */

const KEY_PREFIX = 'uboss.dashboard.order.';

const keyFor = (tenantId: string): string => `${KEY_PREFIX}${tenantId}`;

/** The arranged order for this company, or null when there is none or the store is unavailable. */
export function readTileOrder(tenantId: string | null): string[] | null {
  if (tenantId === null) return null;
  try {
    const stored = window.localStorage.getItem(keyFor(tenantId));
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // Private window, blocked site data, or something else wrote nonsense here. Either way the
    // server's order is a correct answer, so there is nothing to recover.
    return null;
  }
}

/** Records an arrangement. Failing to store it must never fail the screen. */
export function rememberTileOrder(tenantId: string | null, order: readonly string[]): void {
  if (tenantId === null) return;
  try {
    window.localStorage.setItem(keyFor(tenantId), JSON.stringify(order));
  } catch {
    // The arrangement still applies for this visit; it just will not survive a reload.
  }
}

/** Forgets the arrangement, so the server's own order is used again. */
export function forgetTileOrder(tenantId: string | null): void {
  if (tenantId === null) return;
  try {
    window.localStorage.removeItem(keyFor(tenantId));
  } catch {
    // An unreadable store is also an unwritable one.
  }
}

/**
 * Put the server's tiles into the arranged order.
 *
 * Anything the arrangement does not mention keeps its place at the end, in the order the server
 * sent it — so a tile that appears because somebody was granted a new area shows up rather than
 * being silently dropped for not being in a list written before it existed.
 */
export function applyTileOrder<T>(
  tiles: readonly T[],
  keyOf: (tile: T) => string,
  order: readonly string[] | null,
): T[] {
  if (order === null || order.length === 0) return [...tiles];

  const rank = new Map(order.map((key, index) => [key, index]));
  const known = tiles.filter((tile) => rank.has(keyOf(tile)));
  const rest = tiles.filter((tile) => !rank.has(keyOf(tile)));

  known.sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  return [...known, ...rest];
}

/**
 * Move one tile to where another sits, and return the new order.
 *
 * Takes the full list rather than only the moved pair, so the result is a complete order that can
 * be stored as-is. Dropping a tile on itself, or on something not in the list, changes nothing.
 */
export function reorderTiles(current: readonly string[], moved: string, target: string): string[] {
  if (moved === target) return [...current];
  const from = current.indexOf(moved);
  const to = current.indexOf(target);
  if (from === -1 || to === -1) return [...current];

  const next = [...current];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Which tiles somebody has made large — PRD 1.1's other half.
 *
 * **Large, not wide.** The first attempt made a tile span two grid columns, and it changed
 * nothing: a lane on this screen is about 410px across and its columns are `minmax(258px, 1fr)`,
 * so `auto-fit` only ever produces one. There was nothing to span. The lanes are narrow by design
 * — they flank the core of a diagram — so the size a tile can actually grow in is its own, not
 * the lane's.
 *
 * Stored under its own key rather than folded into the order, so an arrangement written before
 * sizes existed keeps working: an older browser's stored order is still a valid order, and this
 * reads as "none of them are large".
 *
 * A set rather than a size per tile, because there are two sizes. The day there is a third, this
 * becomes a map and the key changes with it.
 */
const LARGE_PREFIX = 'uboss.dashboard.large.';

const largeKeyFor = (tenantId: string): string => `${LARGE_PREFIX}${tenantId}`;

/** The tiles made large in this company, or an empty set when there are none. */
export function readLargeTiles(tenantId: string | null): Set<string> {
  if (tenantId === null) return new Set();
  try {
    const stored = window.localStorage.getItem(largeKeyFor(tenantId));
    if (stored === null) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    // Unreadable store. Every tile at its ordinary size is a correct answer.
    return new Set();
  }
}

/** Records which are large. Failing to store it must never fail the screen. */
export function rememberLargeTiles(tenantId: string | null, large: ReadonlySet<string>): void {
  if (tenantId === null) return;
  try {
    window.localStorage.setItem(largeKeyFor(tenantId), JSON.stringify([...large]));
  } catch {
    // It still applies for this visit.
  }
}

/** Forgets the sizes, so every tile is its ordinary size again. */
export function forgetLargeTiles(tenantId: string | null): void {
  if (tenantId === null) return;
  try {
    window.localStorage.removeItem(largeKeyFor(tenantId));
  } catch {
    // An unreadable store is also an unwritable one.
  }
}
