import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScoreServer } from './server.mjs';
import { DISCOVERY_PORT, startDiscovery } from './discovery.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.SCORE_PORT ?? 3080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SCORE_PORT must be between 1 and 65535');
const host = process.env.SCORE_HOST ?? '0.0.0.0';
const discoveryPort = Number(process.env.SCORE_DISCOVERY_PORT ?? DISCOVERY_PORT);
if (!Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65535) throw new Error('SCORE_DISCOVERY_PORT must be between 1 and 65535');
const databasePath = path.resolve(process.env.SCORE_DB_PATH ?? path.join(root, 'data/scores.sqlite'));
mkdirSync(path.dirname(databasePath), { recursive: true });
const server = createScoreServer({ databasePath });
let discovery;
function fail(error) { console.error(error.message); process.exitCode = 1; server.close(); }
server.on('close', () => { if (discovery) { discovery.close(); discovery = null; } });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  server.on('error', fail);
  discovery = await startDiscovery({ httpPort: port, serverId: server.scoreServerId, port: discoveryPort, host, onError: fail });
  console.log(`Score server: http://localhost:${port}`);
  console.log(`Automatic discovery: UDP ${discoveryPort}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${port}`);
    }
  }
  console.log(`Database: ${databasePath}`);
} catch (error) { fail(error); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
