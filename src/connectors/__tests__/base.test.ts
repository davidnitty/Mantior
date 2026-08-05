import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import {
  BaseConnector,
  type ConnectorConfig,
  type ConnectorRequest,
  type ConnectorResponse,
} from '../base';

class TestConnector extends BaseConnector {
  constructor(config: ConnectorConfig, audit?: AuditLogger) {
    super(config, audit);
  }

  async request(_req: ConnectorRequest): Promise<ConnectorResponse> {
    return { status: 200, headers: {}, body: null, duration: 0 };
  }

  run(fn: () => Promise<string>): Promise<string> {
    return this.executeWithRetries(fn, 'test-context');
  }
}

describe('BaseConnector retries', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-connector-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const config = (retries: number): ConnectorConfig => ({
    name: 'test',
    type: 'rest',
    timeout: 1000,
    retries,
  });

  it('succeeds once a retry succeeds', async () => {
    const connector = new TestConnector(
      config(3),
      new AuditLogger(MantiorDatabase.getInstance(dbPath)),
    );
    let attempts = 0;
    const value = await connector.run(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('transient');
      }
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting retries and audits the failure', async () => {
    const audit = new AuditLogger(MantiorDatabase.getInstance(dbPath));
    const connector = new TestConnector(config(2), audit);
    await expect(
      connector.run(async () => Promise.reject(new Error('always fails'))),
    ).rejects.toThrow('always fails');
    expect(audit.search({ action: 'connector_failure' })).toHaveLength(1);
  });
});
