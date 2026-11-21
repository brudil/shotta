/**
 * Writing a shot as something other than a PNG. The browser that took the
 * shots can encode WebP and JPEG, so an export needs no encoder of its own.
 */
import { readFile, writeFile } from 'node:fs/promises';

import type { Browser } from 'playwright';

export type ImageFormat = 'png' | 'webp' | 'jpeg';

/** The extension each format's files are given. */
export const EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  webp: 'webp',
  jpeg: 'jpg',
};

/** The format a file name asks for, by its extension; null for none it knows. */
export function formatOf(file: string): ImageFormat | null {
  const extension = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (extension === 'png') return 'png';
  if (extension === 'webp') return 'webp';
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg';
  return null;
}

export interface EncodeJob {
  /** The PNG to read. */
  from: string;
  /** The file to write. */
  to: string;
  format: 'webp' | 'jpeg';
  /** 1 to 100. */
  quality: number;
}

/** Write each PNG again in the format its job names, pixel for pixel. */
export async function encodeImages(
  browser: Browser,
  jobs: EncodeJob[],
): Promise<void> {
  const page = await browser.newPage();
  try {
    for (const { from, to, format, quality } of jobs) {
      const png = (await readFile(from)).toString('base64');
      const encoded = await page.evaluate(
        async ({ data, type, quality }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, type, quality),
          );
          // A canvas asked for a type it cannot write answers with a PNG.
          if (blob === null || blob.type !== type) return null;
          return new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve(String(reader.result).replace(/^[^,]*,/, ''));
            reader.readAsDataURL(blob);
          });
        },
        { data: png, type: `image/${format}`, quality: quality / 100 },
      );
      if (encoded === null) {
        throw new Error(`the browser could not write ${to} as ${format}`);
      }
      await writeFile(to, Buffer.from(encoded, 'base64'));
    }
  } finally {
    await page.close();
  }
}
