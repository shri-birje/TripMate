/**
 * Geometry for the donut chart, drawn from plain views (there is no SVG library). The ring is made of many thin tiles laid around
 * a circle; each tile takes the colour of the category its centre angle falls in.
 */
export interface DonutTile {
  /** Centre angle in degrees, clockwise from 12 o'clock. */
  angle: number;
  /** Index of the segment (category) the tile belongs to. */
  segment: number;
}

/**
 * `tenths` are each category's share in tenths of a percent (they add up to 1000, or are all zero).
 * With no spending there are no tiles. A single category fills the whole ring.
 */
export function donutTiles(tenths: readonly number[], tileCount = 240): DonutTile[] {
  const total = tenths.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const ends: number[] = [];
  let running = 0;
  for (const t of tenths) {
    running += t;
    ends.push(running);
  }
  const tiles: DonutTile[] = [];
  for (let i = 0; i < tileCount; i += 1) {
    const position = ((i + 0.5) / tileCount) * total;
    let segment = ends.findIndex((end) => position < end);
    if (segment < 0) segment = ends.length - 1;
    tiles.push({ angle: ((i + 0.5) / tileCount) * 360, segment });
  }
  return tiles;
}
