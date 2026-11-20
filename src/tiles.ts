/** Cutting a tall screenshot into pieces a vision model can read. */
import { readFile, writeFile } from 'node:fs/promises';

import { PNG } from 'pngjs';

/** Rows shared by neighbouring tiles, so nothing is seen only cut in half. */
const OVERLAP = 80;

export interface TileRange {
  top: number;
  height: number;
}

/**
 * Where to cut an image `height` rows tall into tiles of at most `max` rows.
 * Every tile but a lone one is full height: the last is aligned to the bottom
 * edge rather than left as a sliver.
 */
export function tileRanges(height: number, max: number): TileRange[] {
  if (height <= max) return [{ top: 0, height }];
  const ranges: TileRange[] = [];
  const stride = max - OVERLAP;
  for (let top = 0; top + max < height; top += stride) {
    ranges.push({ top, height: max });
  }
  ranges.push({ top: height - max, height: max });
  return ranges;
}

/**
 * Write `<name>.1.png`, `<name>.2.png`, … beside a screenshot, top to bottom.
 * An image that already fits is its own only tile, and nothing is written.
 * @returns the tiles' paths
 */
export async function writeTiles(file: string, max: number): Promise<string[]> {
  const image = PNG.sync.read(await readFile(file));
  const ranges = tileRanges(image.height, max);
  if (ranges.length === 1) return [file];
  const tiles: string[] = [];
  for (const [index, range] of ranges.entries()) {
    const tile = new PNG({ width: image.width, height: range.height });
    PNG.bitblt(image, tile, 0, range.top, image.width, range.height, 0, 0);
    const path = file.replace(/\.png$/, `.${index + 1}.png`);
    await writeFile(path, PNG.sync.write(tile));
    tiles.push(path);
  }
  return tiles;
}
