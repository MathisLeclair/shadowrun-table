// Regenerates snapshot.json (skills, core metatypes, cyberware grades, the Fake SIN / Fake License / Custom Item gear
// nodes) from the Chummer data folder, so the .chum5 import/export keeps working on a machine without Chummer installed.
//   node server/lib/chummer/build-snapshot.ts   (CHUMMER_DATA_DIR=<…/Chummer5a/data> when it is not ../Chummer5.226.0/data)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsData, metatypeData, gradeTable, chummerDataDir, findDataItem, BUILTIN_GEAR } from './data.ts';
import { serializeXml } from './xml.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshot.json');
const sd = skillsData();
if (!sd.active.length) {
  console.error(`Chummer data not found (${chummerDataDir()})`);
  process.exit(1);
}
const gear = BUILTIN_GEAR.map((name) => {
  const n = findDataItem('gear', { name });
  if (!n) {
    console.error(`gear.xml has no "${name}"`);
    process.exit(1);
  }
  return serializeXml(n, { newline: '\n', indent: '' }).replace(/\n/g, '');
});
const snap = {
  generated: new Date().toISOString(),
  source: chummerDataDir(),
  skills: { active: sd.active, groups: sd.groups, knowledge: sd.knowledge },
  metatypes: ['Human', 'Elf', 'Dwarf', 'Ork', 'Troll'].map((n) => metatypeData(n)).filter(Boolean),
  grades: gradeTable('cyberware'),
  gear,
};
fs.writeFileSync(out, JSON.stringify(snap));
console.log(`snapshot.json: ${snap.skills.active.length} skills, ${snap.metatypes.length} metatypes, ${gear.length} gear nodes`);
