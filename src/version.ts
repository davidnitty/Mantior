import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedVersion: string | undefined;

/** Read the package version at runtime (avoids TS6059 from importing package.json with rootDir=src). */
export function getVersion(): string {
  if (cachedVersion === undefined) {
    try {
      // eslint-disable-next-line unicorn/prefer-module -- __dirname is the correct CJS runtime anchor
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
        version?: string;
      };
      cachedVersion = pkg.version ?? '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}
