// Contact rolls test: node tools/test-contacts.ts  (isolated server on port 3962, exit code != 0 on failure)
// Rules: SR5 « Using Contacts » p. 387-389 (shared/contacts.js, 'actor/contactRoll').
import { startServer, login, client, settle } from './test-client.ts';
import type { ContactSheetSource } from '../shared/contacts.ts';
import { contactFees, bribeCost, reachable, contactSheet, CONNECTION_DETAILS, LOYALTY_LEVELS, FAVOR_RATINGS } from '../shared/contacts.ts';

let failed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log('  ok', msg);
  else {
    failed++;
    console.log('  FAIL', msg);
  }
};
const rejects = (pr: Promise<unknown>, msg: string) => pr.then(() => ok(false, msg), () => ok(true, msg));

// --- pure rules
ok(Object.keys(CONNECTION_DETAILS).length === 12 && Object.keys(LOYALTY_LEVELS).length === 6 && Object.keys(FAVOR_RATINGS).length === 6, 'tables 1-12 / 1-6 / 1-6');
const f = contactFees({ connection: 4, loyalty: 3 });
ok(f.info === 400 && f.goods === 4000 && f.discountPct === 30, 'fees: C × 100 / C × 1 000, Loyalty × 10 %');
ok(bribeCost({ loyalty: 4 }, 2) === 600 && bribeCost({ loyalty: 6 }, 1) === 100, 'bought die = 100 × (7 − Loyalty)');
ok(reachable(5, { connection: 5 }) && !reachable(4, { connection: 5 }), 'reach: 2D6 ≥ Connection');
const sh = contactSheet({ bestiary: { t: { name: 'Dorian Ashe', attributes: { CHA: 6, LOG: 3 }, skills: [{ id: 'etiquette', rating: 3 }] } } } as unknown as ContactSheetSource, { id: 'c', name: 'dorian ashe', connection: 4 }); // minimal partial template
ok(sh.known && sh.cha === 6 && sh.etiquette === 9 && sh.pool === 5 && sh.defaulting, 'sheet by name (accent / case-insensitive): Etiquette pool, Negotiation defaulting');

// --- server
const srv = await startServer({ port: Number(process.env.CONTACTS_TEST_PORT) || 3962 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: 'pc_jane' }));
  await settle();
  const jane = () => gm.state.actors.pc_jane;
  const sophie = jane().contacts.find((c) => c.name === 'Sophie Winters')!; // C3 L4 (bestiary sheet from Foundry)

  const r = await p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: sophie.id, kind: 'reach' });
  ok(r.dice.length === 2 && r.total === r.dice[0] + r.dice[1] && r.contactRoll.available === r.total >= 3 && r.hits === undefined, 'reach: 2D6 total vs Connection 3');
  await rejects(p1.send('dice/secondChance', { logId: r.logId }), 'no Edge reroll on a 2D6 total');

  const n = await p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: sophie.id, kind: 'negotiate', bribe: 2 });
  ok(/Loyauté Sophie Winters \+4/.test(n.breakdown) && /dés achetés \+2/.test(n.breakdown) && n.contactRoll.bribeCost === 600 && n.limit > 0, 'negotiate: runner’s Negotiation + Loyalty 4 + 2 bought dice (600 ¥), Social limit');
  await settle();
  const e = gm.state.log.find((x) => x.id === n.logId);
  ok(e?.roll?.labelI18n?.key === 'Négociation avec {contact}' && e.author === jane().name, 'negotiate logged under the runner with labelI18n');

  const sarah = jane().contacts.find((c) => c.name === 'Sarah Bones')!; // no sheet
  await rejects(p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: sarah.id, kind: 'legwork' }), 'legwork without a sheet refused');
  await rejects(p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: sophie.id, kind: 'reach', secret: true }), 'player secret refused');
  await rejects(p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: sophie.id, kind: 'bogus' }), 'unknown kind refused');
  await rejects(p1.send('actor/contactRoll', { actorId: 'pc_anthony', contactId: sophie.id, kind: 'reach' }), 'other runner refused');

  // A contact named like a bestiary template (Dorian Ashe, CHA 6) can do legwork / networking.
  await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'contacts', item: { name: 'Dorian Ashe', connection: 4, loyalty: 2 } });
  await settle();
  const dorian = jane().contacts.find((c) => c.name === 'Dorian Ashe')!;
  const lw = await p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: dorian.id, kind: 'legwork' });
  ok(lw.pool === 10 && lw.actorId === null && lw.limit > 0 && lw.contactRoll.kind === 'legwork', 'legwork: Connection 4 + CHA 6, Social limit, not the runner’s roll');
  await rejects(p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: dorian.id, kind: 'network' }), 'network needs a threshold');
  const nw = await p1.send('actor/contactRoll', { actorId: 'pc_jane', contactId: dorian.id, kind: 'network', threshold: 3 });
  ok(nw.contactRoll.threshold === 3 && nw.contactRoll.success === nw.hits >= 3, 'network: hits vs target Connection');
  ok(p1.state.shop.contactSearch!.pc_jane.find((c) => c.id === dorian.id)?.known, 'player view knows the contact has a sheet');

  const sec = await gm.send('actor/contactRoll', { actorId: 'pc_jane', contactId: dorian.id, kind: 'legwork', secret: true });
  await settle();
  ok(!p1.state.log.some((l) => l.id === sec.logId) && gm.state.log.some((l) => l.id === sec.logId), 'GM secret roll hidden from players');
} finally {
  srv.stop();
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
