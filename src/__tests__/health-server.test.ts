import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../health-server';

describe('health-server', () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(
      servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
    );
  });

  it('serves liveness, readiness and metrics endpoints', async () => {
    const app = createApp();
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const health = (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<{
      status: string;
    }>;
    await expect(health).resolves.toEqual(expect.objectContaining({ status: 'ok' }));

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);

    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('mantior_scans_total');

    const ping = await fetch(`http://127.0.0.1:${port}/webhook/ping`);
    expect(ping.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
  });
});
