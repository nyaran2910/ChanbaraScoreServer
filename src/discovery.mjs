import dgram from 'node:dgram';

export const DISCOVERY_PORT = 42044;

// Reply to the sender, so neither side needs to know the host's current IP.
// HTTP URLs are constructed by Unity from the response's source address.
export async function startDiscovery({ httpPort, serverId, port = DISCOVERY_PORT, host = '0.0.0.0', onError = console.error }) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (packet, remote) => {
    if (packet.length > 256) return;
    let query;
    try { query = JSON.parse(packet.toString('utf8')); } catch { return; }
    if (query?.type !== 'kosen.score.discover' || query.version !== 1 ||
        typeof query.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(query.nonce)) return;
    const reply = Buffer.from(JSON.stringify({ type: 'kosen.score.offer', version: 1, nonce: query.nonce, serverId, port: httpPort }));
    socket.send(reply, remote.port, remote.address, error => { if (error) onError(error); });
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => { socket.removeListener('error', reject); resolve(); });
  }).catch(error => { socket.close(); throw error; });
  socket.on('error', onError);
  return socket;
}
