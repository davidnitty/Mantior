import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../../health-server';

describe('dashboard api', () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(
      servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
    );
  });

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const app = createApp();
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  }

  it('serves the policies endpoint', async () => {
    const { status, body } = await get('/api/policies');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('serves the workflows endpoint', async () => {
    const { status, body } = await get('/api/workflows');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('serves the audit endpoint', async () => {
    const { status, body } = await get('/api/audit?limit=5');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});
