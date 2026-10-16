import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Elevate only the firewall helper. The HTTP server itself stays under the
// original user's account, and the rules accept traffic only from the LAN.
export function prepareWindowsNetwork({ httpPort, discoveryPort }) {
  if (process.platform !== 'win32' || process.env.KOSEN_SERVER_NETWORK_READY === '1') return;
  const script = fileURLToPath(new URL('../scripts/windows-firewall.ps1', import.meta.url));
  const args = ['-NodePath', process.execPath, '-HttpPort', String(httpPort), '-DiscoveryPort', String(discoveryPort)];
  const powershell = 'powershell.exe';
  const options = { encoding: 'utf8', windowsHide: true };
  const check = () => spawnSync(powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly', ...args], options);
  const checked = check();
  if (checked.status === 0) {
    console.log(`Windows Firewall: LAN access ready (TCP ${httpPort}, UDP ${discoveryPort})`);
    return;
  }
  if (checked.error || checked.status !== 10) {
    throw new Error(`Cannot check Windows Firewall: ${checked.error?.message ?? checked.stderr.trim()}`);
  }
  console.log(`Windows Firewall setup: allow this Node.js server from the local subnet on TCP ${httpPort} and UDP ${discoveryPort}.`);
  console.log('Previous Windows app-prompt denials for this node.exe will be disabled; administrator-defined block rules are kept.');
  console.log('Accept the Windows administrator (UAC) prompt. The server will continue without administrator privileges.');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `& ${quote(script)} -NodePath ${quote(process.execPath)} -HttpPort ${httpPort} -DiscoveryPort ${discoveryPort}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const elevate = `$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}'; exit $p.ExitCode } catch { Write-Error $_; exit 1 }`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', elevate], options);
  if (result.status !== 0 || check().status !== 0) {
    throw new Error('Windows Firewall setup did not complete. Run npm start again and accept the administrator prompt. If your organization manages the firewall, ask its administrator to allow this Node.js program on the two LAN ports.');
  }
  console.log(`Windows Firewall: LAN access ready (TCP ${httpPort}, UDP ${discoveryPort})`);
}
