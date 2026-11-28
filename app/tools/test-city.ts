// City map test: node tools/test-city.ts  (isolated server on port 3254, exit code != 0 on failure)
// Pure helpers (shared/city.ts) on the traced Seattle districts (data/city/seattle.json), then the server: the city view,
// shop/move (first placement free, one fee for spot + flat, GM free), GM invitations, what players see, GM settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import { districtAt, districtBBox, districtLabelAt, guessDistrict, homeSecurity, inRings, placeAt, sanitizePlace, samePlace } from '../shared/city.ts';
import type { Actor, CityShapes, Lifestyle } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shapes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city', 'seattle.json'), 'utf8')) as CityShapes;

let failures = 0;
let passes = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗', msg);
  }
}
async function rejects(promise: Promise<unknown>, re: RegExp, msg: string) {
  try {
    await promise;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test((e as Error).message), `${msg} — got: ${(e as Error).message}`);
  }
}

console.log('• shared/city.ts on data/city/seattle.json');
ok(shapes.width === 132 && shapes.height === 124 && shapes.districts.length === 12, 'Seattle shapes: 132 × 124 cells, 12 districts');
ok(/^COPY data\/city \.\/data\/city$/m.test(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')), 'Dockerfile ships data/city (else the deployed city has no districts)');
// one point inside each district (full-res px of the image ÷ 25 px per cell)
const SEEDS: Record<string, [number, number]> = {
  everett: [960, 450], snohomish: [990, 810], redmond: [1410, 1050], downtown: [900, 900], 'council-island': [1035, 1260], bellevue: [1170, 1260],
  renton: [1440, 1410], outremer: [660, 1530], tacoma: [690, 1980], auburn: [1410, 1800], puyallup: [1200, 2400], 'fort-lewis': [450, 2430],
};
for (const [id, [px, py]] of Object.entries(SEEDS)) ok(districtAt(shapes.districts, px / 25, py / 25)?.id === id, `${id}: seed point inside`);
// lakes and road numbers inside a district belong to it (px of the image ÷ 25)
ok(districtAt(shapes.districts, 1197 / 25, 1603 / 25)?.id === 'renton', 'the lake in Renton is part of Renton');
ok(districtAt(shapes.districts, 1371 / 25, 1817 / 25)?.id === 'auburn', 'road number 169 is part of Auburn');
ok(districtAt(shapes.districts, 1101 / 25, 1077 / 25)?.id === 'bellevue', 'road number 405 is part of Bellevue');
ok(districtAt(shapes.districts, 240 / 25, 1200 / 25) === null, 'Puget Sound: no district');
ok(districtAt(shapes.districts, 2400 / 25, 1500 / 25) === null, 'east of the metroplex: no district');
for (const d of shapes.districts) {
  const p = districtLabelAt(d);
  ok(inRings(d.rings, p.x, p.y), `${d.id}: label point inside`);
  const bb = districtBBox(d);
  ok(bb.w > 0 && bb.h > 0 && bb.x >= 0 && bb.y >= 0 && bb.x + bb.w <= 132 && bb.y + bb.h <= 124, `${d.id}: bbox inside the map`);
}
ok(shapes.districts.find((d) => d.id === 'downtown')?.security?.[0]?.rating === 'AAA', 'Downtown: AAA (SR5 p. 352)');
ok(shapes.districts.find((d) => d.id === 'redmond')?.security?.[0]?.area === 'Redmond Barrens', 'Redmond: the Barrens only');
ok(shapes.districts.filter((d) => d.security).length === 2, 'no invented ratings for the other districts');
ok(guessDistrict('Seattle Downtown Outskirts (Moyen)', shapes.districts) === 'downtown', 'guessDistrict: Downtown Outskirts');
ok(guessDistrict('Studio à RENTON', shapes.districts) === 'renton', 'guessDistrict: case-insensitive');
ok(guessDistrict('Caserne de Fort Lewis', shapes.districts) === 'fort-lewis', 'guessDistrict: Ft. / Fort');
ok(guessDistrict('Best Home', shapes.districts) === null, 'guessDistrict: none');
ok(homeSecurity('Luxury') === 'AA' && homeSecurity('High') === 'A' && homeSecurity('Medium') === 'B' && homeSecurity('Low') === 'C', 'home rating by level');
ok(homeSecurity('Squatter') === null && homeSecurity('Street') === null, 'no rating where the table has no row');
const city = { width: 132, height: 124, districts: shapes.districts };
const p0 = placeAt(city, 57.6, 56.4, 5)!;
ok(p0.district === 'renton' && p0.at === 5, 'placeAt: district from the shapes');
ok(placeAt(city, 500, -3, 1)!.x === 132 && placeAt(city, 500, -3, 1)!.y === 0, 'placeAt: clamped to the map');
ok(placeAt(city, 'x', 3, 1) === null, 'placeAt: not a number → null');
ok(samePlace({ x: 3.2, y: 4.9 }, { x: 3.8, y: 4.1 }) && !samePlace({ x: 3, y: 4 }, { x: 4, y: 4 }), 'samePlace: same cell');
const sp = sanitizePlace({ x: '12.345', y: 7, district: 'renton', at: 9, guests: ['pc_a', 'pc_a', 3, ''], evil: 1 })!;
ok(sp.x === 12.35 && sp.y === 7 && sp.district === 'renton' && sp.guests?.length === 1 && !('evil' in sp), 'sanitizePlace');
ok(sanitizePlace({ y: 3 }) === null && sanitizePlace('x') === null, 'sanitizePlace: no point → null');

console.log('• server');
const A = (c: TestClient, id: string) => c.state.actors[id] as Actor;
const L = (c: TestClient, id: string): Lifestyle | undefined => A(c, id)?.lifestyles?.[0];
const RENTON = { x: 1440 / 25, y: 1410 / 25 };
const AUBURN = { x: 1410 / 25, y: 1800 / 25 };
const srv = await startServer({ port: 3254 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const pa = await client(srv.url, await login(srv.url, { role: 'player', name: 'Anthony', characterId: 'pc_anthony' }));
  const pb = await client(srv.url, await login(srv.url, { role: 'player', name: 'Bricks', characterId: 'pc_bricks' }));
  await settle();
  ok(gm.state.city?.map?.id === 'map_fvtt_seattle' && gm.state.city.districts.length === 12, 'GM: city map guessed from the background, 12 districts');
  ok(pa.state.city?.map?.id === 'map_fvtt_seattle' && pa.state.city.districts.length === 12 && !pa.state.maps.map_fvtt_seattle, 'player: city image + districts without the table map');
  ok(Array.isArray(pa.state.city.pins) && !pa.state.city.pins.length, 'no homes placed yet');

  const ls = L(gm, 'pc_anthony')!.id;
  const bl = L(gm, 'pc_bricks')!.id;
  let n0 = A(pa, 'pc_anthony').nuyen;
  let r = await pa.send<{ fee: number }>('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...RENTON });
  await settle();
  ok(r.fee === 0 && L(pa, 'pc_anthony')!.place?.district === 'renton' && A(pa, 'pc_anthony').nuyen === n0, 'first placement is free, district computed');
  ok(pa.state.city.pins.length === 1 && pa.state.city.pins[0].own && pa.state.city.pins[0].district === 'renton', 'player sees their own pin');
  await rejects(pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, x: RENTON.x + 0.1, y: RENTON.y }), /already live here/, 'same spot refused');
  await rejects(pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls }), /Nothing to change/, 'nothing to change refused');
  await rejects(pb.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...AUBURN }), /not your character/, 'cannot move another runner');
  r = await pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, layout: 'medium-loft' });
  await settle();
  ok(r.fee === 0 && L(pa, 'pc_anthony')!.home?.layout === 'medium-loft' && A(pa, 'pc_anthony').nuyen === n0, 'first flat after the spot: free');
  r = await pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...AUBURN, layout: 'medium-classic' });
  await settle();
  let l = L(pa, 'pc_anthony')!;
  ok(r.fee === 5000 && A(pa, 'pc_anthony').nuyen === n0 - 5000, 'spot + flat change together: one fee');
  ok(l.place?.district === 'auburn' && l.home?.layout === 'medium-classic' && l.home.moves === 1, 'new spot and flat stored, one move counted');
  n0 = A(pa, 'pc_anthony').nuyen;
  r = await pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...RENTON });
  await settle();
  ok(r.fee === 5000 && A(pa, 'pc_anthony').nuyen === n0 - 5000 && L(pa, 'pc_anthony')!.home?.moves === 2, 'spot change alone: a move');

  console.log('• visibility & invitations');
  ok(!pb.state.city.pins.length, 'other player: no pin');
  ok(!L(pb, 'pc_anthony')?.place && !L(pb, 'pc_anthony')?.home, 'other player: home and spot stripped from the other sheet');
  await rejects(pa.send('actor/updateItem', { actorId: 'pc_anthony', list: 'lifestyles', itemId: ls, patch: { place: { x: 1, y: 1, guests: ['pc_bricks'] } } }), /Only the GM/, 'player cannot set the spot directly');
  await rejects(pa.send('city/invite', { actorId: 'pc_anthony', lifestyleId: ls, guests: ['pc_bricks'] }), /./, 'player cannot invite');
  r = await gm.send('city/invite', { actorId: 'pc_anthony', lifestyleId: ls, guests: ['pc_bricks', 'pc_anthony', 'nobody'] });
  await settle();
  ok(JSON.stringify(L(gm, 'pc_anthony')!.place?.guests) === '["pc_bricks"]', 'GM invite: PCs only, not the owner');
  ok(pb.state.city.pins.length === 1 && !pb.state.city.pins[0].own && pb.state.city.pins[0].layout === 'medium-classic' && !pb.state.city.pins[0].guests.length, 'invited player sees the home (not the guest list)');
  ok(L(pb, 'pc_anthony')?.place?.district === 'renton' && L(pb, 'pc_anthony')?.home?.layout === 'medium-classic' && !L(pb, 'pc_anthony')?.place?.guests, 'invited player: sheet keeps the home');
  ok(gm.state.city.pins.length === 1 && gm.state.city.pins[0].guests[0] === 'pc_bricks', 'GM sees the guests');
  await pa.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...AUBURN });
  await settle();
  ok(!pb.state.city.pins.length && !L(gm, 'pc_anthony')!.place?.guests, 'a new spot forgets the invitations');

  console.log('• GM');
  n0 = A(gm, 'pc_bricks').nuyen;
  await gm.send('shop/move', { actorId: 'pc_bricks', lifestyleId: bl, ...RENTON });
  r = await gm.send('shop/move', { actorId: 'pc_bricks', lifestyleId: bl, ...AUBURN });
  await settle();
  ok(r.fee === 0 && A(gm, 'pc_bricks').nuyen === n0 && gm.state.city.pins.length === 2, 'GM moves for free');
  await gm.send('city/unplace', { actorId: 'pc_bricks', lifestyleId: bl });
  await settle();
  ok(!L(gm, 'pc_bricks')!.place && gm.state.city.pins.length === 1, 'GM takes a home off the map');
  await rejects(gm.send('city/settings', { mapId: 'nope' }), /not found/, 'unknown city map refused');
  await gm.send('city/settings', { names: { renton: 'Renton (Ares)', nope: 'x' } });
  await settle();
  ok(pa.state.city.districts.find((d) => d.id === 'renton')?.name === 'Renton (Ares)', 'GM renames a district');
  await gm.send('city/settings', { names: { renton: '' } });
  await settle();
  ok(gm.state.city.districts.find((d) => d.id === 'renton')?.name === 'Renton', 'empty name → traced name');
  const other = Object.keys(gm.state.maps).find((id) => id !== 'map_fvtt_seattle')!;
  await gm.send('city/settings', { mapId: other });
  await settle();
  ok(gm.state.city.map?.id === other && !gm.state.city.districts.length, 'another map as city: no traced districts');
  await gm.send('shop/move', { actorId: 'pc_anthony', lifestyleId: ls, ...RENTON });
  await settle();
  ok(L(gm, 'pc_anthony')!.place?.district === null, 'map without districts: a spot without district');
  await gm.send('city/settings', { mapId: null });
  await settle();
  ok(gm.state.city.map?.id === 'map_fvtt_seattle' && gm.state.city.districts.length === 12, 'back to the guessed Seattle map');
  const errors = srv.output().split('\n').filter((x) => /\[action|Error|failed/i.test(x));
  ok(!errors.length, `no server errors: ${errors.join(' | ')}`);
  gm.close();
  pa.close();
  pb.close();
} catch (err) {
  failures++;
  console.error('Test crashed:', err);
  console.error(srv.output());
} finally {
  await srv.stopAndWait();
}
console.log(`\n${passes} ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
