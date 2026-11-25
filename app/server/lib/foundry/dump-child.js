// Child process used by readWorldSync(): node dump-child.js <worldPath> <outFile> <collections,comma,separated>
// Reads the world asynchronously and writes the assembled result as JSON to <outFile>.
import fs from 'node:fs';
import { readWorld, COLLECTIONS } from './world.js';

const [worldPath, outFile, colls] = process.argv.slice(2);
try {
  const collections = colls ? colls.split(',').filter(Boolean) : COLLECTIONS;
  const world = await readWorld(worldPath, { collections });
  fs.writeFileSync(outFile, JSON.stringify(world));
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + '\n');
  process.exit(1);
}
