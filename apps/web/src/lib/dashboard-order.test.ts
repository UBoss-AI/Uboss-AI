import { describe, expect, it } from 'vitest';

import { applyTileOrder, reorderTiles } from './dashboard-order';

/**
 * The arranging rules, which are mostly about what must *not* happen.
 *
 * An arrangement is a view preference sitting in front of a permission decision the server has
 * already made. The dangerous mistakes are therefore not about order at all: dropping a tile the
 * server sent because an old stored list does not mention it, or resurrecting one it did not send
 * because the list still does. Both would make a personal preference look like an access change.
 */
describe('arranging the Dashboard tiles', () => {
  const tiles = (...keys: string[]): { tile: string }[] => keys.map((tile) => ({ tile }));
  const keyOf = (tile: { tile: string }): string => tile.tile;
  const keysOf = (list: { tile: string }[]): string[] => list.map(keyOf);

  describe('applying a stored order', () => {
    it('uses the server order when nothing has been arranged', () => {
      expect(keysOf(applyTileOrder(tiles('a', 'b', 'c'), keyOf, null))).toEqual(['a', 'b', 'c']);
      expect(keysOf(applyTileOrder(tiles('a', 'b', 'c'), keyOf, []))).toEqual(['a', 'b', 'c']);
    });

    it('puts them in the arranged order', () => {
      expect(keysOf(applyTileOrder(tiles('a', 'b', 'c'), keyOf, ['c', 'a', 'b']))).toEqual([
        'c',
        'a',
        'b',
      ]);
    });

    it('keeps a tile the arrangement has never heard of', () => {
      // Somebody is granted a new area. It was not in the list they arranged last month, and it
      // must still appear — at the end, where a new thing belongs.
      expect(keysOf(applyTileOrder(tiles('a', 'b', 'new'), keyOf, ['b', 'a']))).toEqual([
        'b',
        'a',
        'new',
      ]);
    });

    it('ignores an arranged tile the server did not send', () => {
      // An area somebody no longer has. The stored order still names it; the screen must not.
      expect(keysOf(applyTileOrder(tiles('a', 'b'), keyOf, ['gone', 'b', 'a']))).toEqual([
        'b',
        'a',
      ]);
    });

    it('never invents or loses a tile', () => {
      const given = tiles('a', 'b', 'c', 'd');
      const out = applyTileOrder(given, keyOf, ['d', 'x', 'b']);
      expect(out).toHaveLength(given.length);
      expect([...keysOf(out)].sort()).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('moving one', () => {
    it('drops it where the target sits', () => {
      expect(reorderTiles(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
      expect(reorderTiles(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    });

    it('changes nothing when a tile is dropped on itself', () => {
      expect(reorderTiles(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
    });

    it('changes nothing when either end is not in the list', () => {
      expect(reorderTiles(['a', 'b'], 'ghost', 'a')).toEqual(['a', 'b']);
      expect(reorderTiles(['a', 'b'], 'a', 'ghost')).toEqual(['a', 'b']);
    });

    it('returns a complete order, not just the pair that moved', () => {
      const out = reorderTiles(['a', 'b', 'c', 'd'], 'd', 'b');
      expect(out).toEqual(['a', 'd', 'b', 'c']);
      expect(out).toHaveLength(4);
    });
  });
});
