import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BreakingChange } from '../../diff/engine';
import { PythonASTWalker } from '../ast-walker-python';

function pythonAvailableSync(): boolean {
  for (const candidate of ['python3', 'python', 'py']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

const hasPython = pythonAvailableSync();
const describeIfPython = hasPython ? describe : describe.skip;

describeIfPython('PythonASTWalker', () => {
  const walker = new PythonASTWalker();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'mantior-python-test');
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('finds property access call sites', async () => {
    const code = [
      'import requests',
      "response = requests.post('https://api.example.com/charge', json={'amount': 100})",
      'print(response.amount)',
      'total = response.amount + 50',
    ].join('\n');
    const filePath = join(testDir, 'test.py');
    writeFileSync(filePath, code);

    const changes: BreakingChange[] = [
      {
        type: 'property_removed',
        property: 'amount',
        severity: 'breaking',
        confidence: 100,
        message: 'amount removed',
      },
    ];
    const callSites = await walker.findCallSites(testDir, changes);

    expect(callSites).toHaveLength(2);
    expect(callSites[0]?.line).toBe(3);
    expect(callSites[1]?.line).toBe(4);
  });

  it('finds destructured subscriptions', async () => {
    const code = [
      'from api import client',
      "response = client.get_charge('123')",
      "amount = response['amount']",
      "currency = response['currency']",
    ].join('\n');
    const filePath = join(testDir, 'test.py');
    writeFileSync(filePath, code);

    const changes: BreakingChange[] = [
      {
        type: 'property_removed',
        property: 'amount',
        severity: 'breaking',
        confidence: 100,
        message: 'amount removed',
      },
    ];
    const callSites = await walker.findCallSites(testDir, changes);

    expect(callSites.length).toBeGreaterThan(0);
  });

  it('skips files in venv', async () => {
    const venvDir = join(testDir, 'venv');
    mkdirSync(venvDir, { recursive: true });
    writeFileSync(join(venvDir, 'test.py'), 'response.amount');

    const changes: BreakingChange[] = [
      {
        type: 'property_removed',
        property: 'amount',
        severity: 'breaking',
        confidence: 100,
        message: 'amount removed',
      },
    ];
    const callSites = await walker.findCallSites(testDir, changes);

    expect(callSites).toHaveLength(0);
  });
});
