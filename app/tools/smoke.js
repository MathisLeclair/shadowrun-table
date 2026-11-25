// Quick end-to-end smoke test: node tools/smoke.js
import { startServer, login, client, settle } from './test-client.js';
const srv = await startServer({ port: 3998 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  await gm.send('chat/send', { text: 'test' });
  await settle();
  console.log('log entries:', gm.state.log.length, '| actors:', Object.keys(gm.state.actors).length, '| maps:', Object.keys(gm.state.maps || {}).length);
  gm.close();
} finally {
  srv.stop();
}
