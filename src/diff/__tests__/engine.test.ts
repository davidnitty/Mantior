import { join } from 'node:path';

import { DiffEngine } from '../engine';

describe('DiffEngine', () => {
  const engine = new DiffEngine();

  describe('compare()', () => {
    it('detects removed endpoints', async () => {
      const oldSpec = { paths: { '/v1/charges': { post: {} }, '/v1/refunds': { post: {} } } };
      const newSpec = { paths: { '/v1/charges': { post: {} } } };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'endpoint_removed',
          path: '/v1/refunds',
          severity: 'breaking',
        }),
      );
    });

    it('detects property renames', async () => {
      const oldSpec = {
        components: {
          schemas: {
            ChargeRequest: {
              properties: { amount: { type: 'number' }, currency: { type: 'string' } },
            },
          },
        },
      };
      const newSpec = {
        components: {
          schemas: {
            ChargeRequest: {
              properties: { amount_cents: { type: 'integer' }, currency: { type: 'string' } },
            },
          },
        },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'property_renamed',
          property: 'amount',
          newProperty: 'amount_cents',
          severity: 'breaking',
        }),
      );
    });

    it('detects type changes', async () => {
      const oldSpec = {
        components: { schemas: { ChargeRequest: { properties: { amount: { type: 'number' } } } } },
      };
      const newSpec = {
        components: { schemas: { ChargeRequest: { properties: { amount: { type: 'integer' } } } } },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'type_changed',
          property: 'amount',
          oldType: 'number',
          newType: 'integer',
          severity: 'breaking',
        }),
      );
    });

    it('flags newly required fields as risky', async () => {
      const oldSpec = {
        components: {
          schemas: { ChargeRequest: { properties: { amount: { type: 'number' } }, required: [] } },
        },
      };
      const newSpec = {
        components: {
          schemas: {
            ChargeRequest: { properties: { amount: { type: 'number' } }, required: ['amount'] },
          },
        },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({ type: 'required_added', property: 'amount', severity: 'risky' }),
      );
    });

    it('returns empty array when nothing changed', async () => {
      const spec = {
        paths: { '/v1/charges': { post: {} } },
        components: { schemas: { ChargeRequest: { properties: { amount: { type: 'number' } } } } },
      };

      const changes = await engine.compare(spec, spec);

      expect(changes).toHaveLength(0);
    });

    it('compares local YAML spec files (js-yaml path)', async () => {
      const v1Path = join(process.cwd(), '__fixtures__', 'specs', 'payment-api-v1.yaml');
      const v2Path = join(process.cwd(), '__fixtures__', 'specs', 'payment-api-v2.yaml');

      const changes = await engine.compare(v1Path, v2Path);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'endpoint_removed',
          path: '/v1/charges',
          severity: 'breaking',
        }),
      );
      expect(changes).toContainEqual(
        expect.objectContaining({ type: 'schema_removed', schema: 'ChargeRequest' }),
      );
    });

    it('detects removed enum values', async () => {
      const oldSpec = {
        components: {
          schemas: {
            ChargeResponse: {
              properties: { status: { type: 'string', enum: ['pending', 'success', 'failed'] } },
            },
          },
        },
      };
      const newSpec = {
        components: {
          schemas: {
            ChargeResponse: {
              properties: { status: { type: 'string', enum: ['pending', 'succeeded', 'failed'] } },
            },
          },
        },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'enum_value_removed',
          property: 'status',
          oldValue: 'success',
          severity: 'breaking',
        }),
      );
    });

    it('detects endpoint renames by versioned path + method', async () => {
      const oldSpec = { paths: { '/v1/charges': { post: {} } } };
      const newSpec = { paths: { '/v2/charges': { post: {} } } };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'endpoint_renamed',
          oldValue: '/v1/charges',
          newValue: '/v2/charges',
          severity: 'breaking',
        }),
      );
    });

    it('detects schema renames by property overlap', async () => {
      const oldSpec = {
        components: {
          schemas: {
            OldCustomer: {
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' },
              },
            },
          },
        },
      };
      const newSpec = {
        components: {
          schemas: {
            NewCustomer: {
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' },
              },
            },
          },
        },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toContainEqual(
        expect.objectContaining({
          type: 'schema_renamed',
          oldValue: 'OldCustomer',
          newValue: 'NewCustomer',
        }),
      );
    });

    it('treats $ref/allOf properties as objects', async () => {
      const oldSpec = {
        components: {
          schemas: { Payment: { properties: { card: { $ref: '#/components/schemas/Card' } } } },
        },
      };
      const newSpec = {
        components: {
          schemas: {
            Payment: { properties: { card: { allOf: [{ $ref: '#/components/schemas/Card' }] } } },
          },
        },
      };

      const changes = await engine.compare(oldSpec, newSpec);

      expect(changes).toHaveLength(0);
    });
  });
});
