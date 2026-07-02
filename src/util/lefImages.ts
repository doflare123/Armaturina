import fs from 'node:fs/promises';
import path from 'node:path';
import { pickRandom } from './random.ts';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Random `lef` image path, or `null` when no image assets exist. */
export async function getRandomLefImage(lefAssetsPath: string): Promise<string | null> {
  const imagePaths = await collectLefImagePaths(lefAssetsPath);

  return imagePaths.length > 0 ? pickRandom(imagePaths) : null;
}

async function collectLefImagePaths(lefAssetsPath: string): Promise<string[]> {
  const paths: string[] = [];

  try {
    const stat = await fs.stat(lefAssetsPath);

    if (stat.isFile() && isImage(lefAssetsPath)) {
      return [lefAssetsPath];
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(lefAssetsPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && isImage(entry.name)) {
          paths.push(path.join(lefAssetsPath, entry.name));
        }
      }
    }
  } catch {
    // Missing folder is fine; fall back to data/lef.jpg below.
  }

  const fallbackPath = path.join(path.dirname(lefAssetsPath), 'lef.jpg');

  try {
    if ((await fs.stat(fallbackPath)).isFile()) {
      paths.push(fallbackPath);
    }
  } catch {
    // No fallback image configured.
  }

  return paths;
}

function isImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
