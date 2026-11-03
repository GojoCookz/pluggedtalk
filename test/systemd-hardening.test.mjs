import { test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';

const ops = new URL('../ops/', import.meta.url);
const REQUIRED = {
  NoNewPrivileges: 'true', ProtectSystem: 'strict', ProtectHome: 'true', PrivateTmp: 'true', PrivateDevices: 'true',
  ProtectKernelTunables: 'true', ProtectKernelModules: 'true', ProtectKernelLogs: 'true', ProtectControlGroups: 'true',
  ProtectClock: 'true', ProtectHostname: 'true', ProtectProc: 'invisible', ProcSubset: 'pid', RestrictSUIDSGID: 'true',
  RestrictNamespaces: 'true', RestrictRealtime: 'true', LockPersonality: 'true', SystemCallArchitectures: 'native',
  CapabilityBoundingSet: '', AmbientCapabilities: '', RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6',
};

test('L10: every Plugged systemd service carries the full hardening set and resource ceilings', async () => {
  const units = (await readdir(ops)).filter(name => name.endsWith('.service'));
  expect(units.sort()).toEqual(['plugged-backup.service', 'plugged-health.service', 'plugged.service']);
  for (const unit of units) {
    const text = await readFile(new URL(unit, ops), 'utf8');
    const directives = Object.fromEntries(text.split(/\r?\n/).filter(l => /^[A-Za-z]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const [key, value] of Object.entries(REQUIRED)) expect({ unit, key, value: directives[key] }).toEqual({ unit, key, value });
    expect(directives.MemoryMax).toMatch(/^\d+[MG]$/);
    expect(Number(directives.TasksMax)).toBeGreaterThan(0);
    expect(directives.User).toBe('plugged');
    expect(directives.MemoryDenyWriteExecute).toBeUndefined(); // Bun JIT
  }
});
