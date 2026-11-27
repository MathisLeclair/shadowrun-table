// SIN checks test: node tools/test-sins.ts  (isolated server on port 3960, exit code != 0 on failure)
// Rules: SR5 « Checking a Fake SIN » (p. 364) — Device Rating × 2 dice, threshold = fake SIN / license rating.
import { startServer, login, client, settle } from './test-client.ts';
import { sinCheckOutcome, parseLicense, sinIdentity, checkOdds, verificationPool, sinNumber } from '../shared/sins.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok', msg);
  else {
    failed++;
    console.log('  FAIL', msg);
  }
};

// --- pure rules
ok(sinCheckOutcome(3, 4) === 'pass' && sinCheckOutcome(4, 4) === 'odd' && sinCheckOutcome(5, 4) === 'burned', 'under = pass, equal = odd, over = burned');
ok(JSON.stringify(parseLicense("Driver's License (4)", { rating: 2 })) === JSON.stringify({ name: "Driver's License", rating: 4 }), 'license « (n) » rating parsed');
ok(parseLicense('Port d’arme', { rating: 3 }).rating === 3, 'license without rating = SIN rating');
ok(sinIdentity({ name: 'Faux SIN — Jane Beauty' }) === 'Jane Beauty', 'identity name without the « Faux SIN — » prefix');
ok(verificationPool(4) === 8 && verificationPool(9) === 12, 'pool = Device Rating × 2 (max rating 6)');
const o = checkOdds(8, 4);
ok(Math.abs(o.pass + o.odd + o.burned - 1) < 1e-9 && o.burned > 0 && o.burned < o.odd, 'odds sum to 1');
ok(sinNumber({ id: 'x1' }) === sinNumber({ id: 'x1' }) && sinNumber({ id: 'x1' }) !== sinNumber({ id: 'x2' }), 'flavor SIN number stable per id');

// --- server
const srv = await startServer({ port: Number(process.env.SINS_TEST_PORT) || 3960 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: 'pc_jane' }));
  await settle();
  const jane = () => gm.state.actors.pc_jane;
  const sin = jane().sins.find((s) => /Jane Beauty/.test(s.name));
  ok(sin && sin.rating === 6, 'seed: Jane Beauty is a rating 6 fake SIN');

  const r = await p1.send('actor/sinCheck', { actorId: 'pc_jane', sinId: sin.id, device: 3 });
  ok(r.pool === 6 && r.dice.length === 6 && r.sinCheck.threshold === 6 && r.sinCheck.outcome === sinCheckOutcome(r.hits, 6), 'player checks own SIN: 6 dice vs 6');
  await settle();
  const e = gm.state.log.find((x) => x.id === r.logId);
  ok(e && e.kind === 'roll' && e.roll.sinCheck && e.roll.labelI18n?.key === 'Contrôle de SIN — {sin}' && !e.gmOnly, 'logged as a visible roll with labelI18n');

  const lr = await p1.send('actor/sinCheck', { actorId: 'pc_jane', sinId: sin.id, license: 0, device: 1 });
  ok(lr.sinCheck.license && lr.sinCheck.threshold === 6 && lr.pool === 2, 'license check uses the license rating');

  await p1.send('actor/sinCheck', { actorId: 'pc_jane', sinId: sin.id, device: 3, secret: true }).then(() => ok(false, 'player secret refused'), () => ok(true, 'player secret refused'));
  await p1.send('actor/sinCheck', { actorId: 'pc_anthony', sinId: sin.id, device: 3 }).then(() => ok(false, 'other actor refused'), () => ok(true, 'other actor refused'));
  await p1.send('actor/sinCheck', { actorId: 'pc_jane', sinId: sin.id, device: 0 }).then(() => ok(false, 'device 0 refused'), () => ok(true, 'device 0 refused'));
  await p1.send('dice/secondChance', { logId: r.logId }).then(() => ok(false, 'no Edge on a SIN check'), () => ok(true, 'no Edge on a SIN check'));

  // Rating 1 SIN vs a rating 6 system: roll until it burns (12 dice vs threshold 1 burns ~98 % of the time).
  const weak = jane().sins.find((s) => s.rating === 1);
  let burned = null;
  for (let i = 0; i < 10 && !burned; i++) {
    const x = await gm.send('actor/sinCheck', { actorId: 'pc_jane', sinId: weak.id, device: 6, secret: i < 1 });
    if (i < 1) {
      await settle();
      ok(!jane().sins.find((s) => s.id === weak.id).burned, 'secret GM check never burns automatically');
      ok(gm.state.log.find((l) => l.id === x.logId)?.gmOnly && !p1.state.log.some((l) => l.id === x.logId), 'secret check hidden from players');
    } else if (x.sinCheck.outcome === 'burned') burned = x;
  }
  await settle();
  ok(burned?.sinCheck.burnedNow && jane().sins.find((s) => s.id === weak.id).burned, 'exceeding the threshold burns the SIN');
  const auto = await p1.send('actor/sinCheck', { actorId: 'pc_jane', sinId: weak.id, device: 1 });
  ok(auto.outcome === 'auto' && !auto.dice, 'burned SIN fails automatically, no roll');

  await p1.send('actor/sinBurn', { actorId: 'pc_jane', sinId: weak.id, burned: false }).then(() => ok(false, 'player cannot restore'), () => ok(true, 'player cannot restore'));
  await gm.send('actor/sinBurn', { actorId: 'pc_jane', sinId: weak.id, burned: false });
  await settle();
  ok(!jane().sins.find((s) => s.id === weak.id).burned, 'GM restores a burned SIN');

  await gm.send('actor/updateItem', { actorId: 'pc_jane', list: 'sins', itemId: weak.id, patch: { real: true } });
  await gm.send('actor/sinCheck', { actorId: 'pc_jane', sinId: weak.id, device: 6 }).then(() => ok(false, 'real SIN: no check'), () => ok(true, 'real SIN: no check'));
} finally {
  srv.stop();
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
