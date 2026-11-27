// Quick end-to-end smoke test: node tools/smoke.ts
import { startServer, login, client, settle } from './test-client.ts';
const srv = await startServer({ port: 3998 });
let code = 0;
try {
  const health = await (await fetch(srv.url + '/api/health')).json();
  const tables = (await (await fetch(srv.url + '/api/tables')).json()).tables;
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  await gm.send('chat/send', { text: 'test' });
  await settle();
  console.log('health:', health.ok, '| tables:', tables.map((t: { slug: string }) => t.slug).join(','), '| log entries:', gm.state.log.length, '| actors:', Object.keys(gm.state.actors).length, '| maps:', Object.keys(gm.state.maps || {}).length);
  if (!health.ok || !gm.state.log.length) code = 1;
  gm.close();
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  srv.stop();
}
process.exit(code);
