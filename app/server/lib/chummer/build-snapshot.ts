// Regenerates snapshot.json (skills, core metatypes, cyberware grades) from the Chummer data folder, so the
// .chum5 import/export keeps working on a machine without Chummer installed.
//   node server/lib/chummer/build-snapshot.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsData, metatypeData, gradeTable, chummerDataDir } from './data.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshot.json');
const sd = skillsData();
if (!sd.active.length) {
  console.error(`Chummer data not found (${chummerDataDir()})`);
  process.exit(1);
}
const snap = {
  generated: new Date().toISOString(),
  source: chummerDataDir(),
  skills: { active: sd.active, groups: sd.groups, knowledge: sd.knowledge },
  metatypes: ['Human', 'Elf', 'Dwarf', 'Ork', 'Troll'].map((n) => metatypeData(n)).filter(Boolean),
  grades: gradeTable('cyberware'),
};
fs.writeFileSync(out, JSON.stringify(snap));
console.log(`snapshot.json: ${snap.skills.active.length} skills, ${snap.metatypes.length} metatypes`);
