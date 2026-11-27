// Homes (shared/home.js): every layout is well formed and every add-on finds a wall.
//   node tools/test-home.ts [--print]
import assert from 'node:assert/strict';
import { HOME_LAYOUTS, homeLayoutsFor, homeLayout, buildHome, homeModuleKey, homeMoveCost, sanitizeHome, homeArea, layoutIssues } from '../shared/home.ts';
import { blocksMove } from '../shared/vision.ts';
import type { HomeBuild, HomeMap } from '../shared/home.ts';

const PRINT = process.argv.includes('--print');
let fails = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log('ok  ', name);
  } catch (e) {
    fails++;
    console.log('FAIL', name, '\n     ', (e as Error).message);
  }
};

/** Every non-blocking cell of the map reachable from the first entrance (doors passable). */
function unreachable(map: HomeMap) {
  const open = { ...map, doors: map.doors.map((d) => ({ ...d, state: 'open' })) };
  const entry = map.doors.find((d) => d.kind === 'door' && d.state !== 'open') || map.doors[0];
  const seen = new Set([`${entry.x},${entry.y}`]);
  const stack: Array<[number, number]> = [[entry.x, entry.y]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || nx < 0 || ny < 0 || nx >= map.width || ny >= map.height || blocksMove(open, nx, ny)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }
  const out: string[] = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (!blocksMove(open, x, y) && !seen.has(`${x},${y}`) && map.tiles[y][x] !== 'D') out.push(`${x},${y}`);
  return out;
}

const ALL_ADDONS = ['Garage (Car (Body 4 or Less))', 'Workshop/Facility', 'Yard', 'Panic Room', 'Gym', 'Armory', 'Swimming Pool', 'Escape Tunnel, 100 Meters', 'Private Room', 'Garage (Car (Body 5 or More))', 'Bat Cave', 'Zen Den', 'Greenhouse', 'Shooting Range'];

for (const lay of Object.values(HOME_LAYOUTS)) {
  check(`layout ${lay.id}`, () => {
    const l = { id: 'l1', name: 'Test', base: lay.bases[0], qualities: [] };
    const { map } = buildHome(l, lay.id)!;
    if (PRINT) console.log(map.tiles.map((r, y) => String(y).padStart(2) + ' ' + r).join('\n'));
    assert.ok(map.doors.some((d) => d.kind === 'door' && d.state !== 'open'), 'no entrance');
    for (const id of Object.keys(lay.rooms)) assert.ok(lay.rows.some((r) => r.includes(id)), `room marker ${id} missing`);
    const rooms = lay.rows.join('').match(/[0-9]/g) || [];
    assert.equal(new Set(rooms).size, rooms.length, 'duplicate room marker');
    const lost = unreachable(map);
    assert.ok(!lost.length, `${lost.length} unreachable cells: ${lost.slice(0, 8).join(' ')}`);
    // A wall gap would merge two rooms.
    assert.deepEqual(layoutIssues(lay.id), []);
  });
}

const MODULE_OPTIONS = ['Garage (Car (Body 4 or Less))', 'Cramped Garage (Car (Body 4 or Less))', 'Garage (Car (Body 5 or More))', 'Cramped Garage (Car (Body 5 or More))', 'Garage (Stable)', 'Garage (Boat)', 'Garage (Helicopter)', 'Garage (Airplane)', 'Workshop/Facility', 'Cramped Workshop/Facility', 'Special Work Area', 'Armory', 'Panic Room', 'Gym', 'Swimming Pool', 'Indoor Arboretum', 'Greenhouse', 'Yard', 'Shooting Range', 'Sports Court - Small', 'Private Room', 'Bat Cave', 'Zen Den', 'Walk-In Freezer', 'Escape Tunnel, 100 Meters', 'Dug a Hole'];
for (const name of MODULE_OPTIONS) {
  check(`module ${name}`, () => {
    assert.ok(homeModuleKey({ name }), 'no module');
    const res = buildHome({ id: 'm', base: 'Luxury', qualities: [{ id: 'q', name }] }, 'lux-villa')!;
    assert.equal(res.placed.length, 1, 'not placed');
    const lost = unreachable(res.map);
    assert.ok(!lost.length, `${lost.length} unreachable cells: ${lost.slice(0, 8).join(' ')}`);
  });
}

for (const base of ['Squatter', 'Low', 'Medium', 'High', 'Luxury']) {
  for (const lay of homeLayoutsFor(base)) {
    check(`add-ons on ${lay.id}`, () => {
      const allowed = base === 'Squatter' ? ['Private Room', 'Escape Tunnel, 100 Meters'] : base === 'Low' ? ['Yard', 'Private Room', 'Escape Tunnel, 100 Meters'] : ALL_ADDONS.slice(0, base === 'Medium' ? 6 : 14);
      const l = { id: 'l2', name: 'Test', base, qualities: allowed.map((name, i) => ({ id: 'q' + i, name })) };
      const res: HomeBuild = buildHome(l, lay.id)!;
      if (PRINT) console.log(res.map.tiles.map((r, y) => String(y).padStart(2) + ' ' + r).join('\n'));
      assert.deepEqual(res.skipped.map((s) => s.key), [], 'skipped add-ons');
      assert.equal(res.placed.length, allowed.length);
      const lost = unreachable(res.map);
      assert.ok(!lost.length, `${lost.length} unreachable cells: ${lost.slice(0, 8).join(' ')}`);
    });
  }
}

check('helpers', () => {
  assert.equal(homeLayoutsFor('Street').length, 0);
  assert.ok(homeLayoutsFor('Medium').length >= 3);
  assert.equal(homeModuleKey({ name: 'Cramped Garage (Car (Body 4 or Less))' }), 'garageSmallCramped');
  assert.equal(homeModuleKey({ name: 'DocWagon Contract, Gold' }), null);
  assert.equal(homeLayout({ base: 'Medium', home: { layout: 'low-studio' } }), null, 'layout of another level');
  assert.equal(homeLayout({ base: 'Low', home: { layout: 'low-studio' } })?.id, 'low-studio');
  assert.equal(homeMoveCost({ base: 'Medium' }), 5000);
  assert.equal(sanitizeHome({ layout: 'nope' }), null);
  assert.deepEqual(sanitizeHome({ layout: 'low-studio', since: 5, moves: -2, x: 1 }), { layout: 'low-studio', since: 5, moves: 0 });
  assert.ok(homeArea(buildHome({ id: 'a', base: 'Low' }, 'low-studio')!.map) > 20);
});

console.log(fails ? `\n${fails} failure(s)` : '\nall ok');
process.exit(fails ? 1 : 0);
