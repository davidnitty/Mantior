import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { GraphQLDiffEngine } from '../diff';

describe('GraphQLDiffEngine', () => {
  const engine = new GraphQLDiffEngine();

  const fixture = (name: string): string => join(process.cwd(), '__fixtures__', 'graphql', name);

  it('returns no changes when schemas are identical', async () => {
    const sdl = 'type A { x: String } type Query { a: A }';
    expect(await engine.compare(sdl, sdl)).toHaveLength(0);
  });

  it('detects removed types', async () => {
    const oldSdl = 'type A { x: String } type B { y: Int } type Query { a: A b: B }';
    const newSdl = 'type A { x: String } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'type_removed', schema: 'B', severity: 'breaking' }),
    );
  });

  it('detects removed fields', async () => {
    const oldSdl = 'type A { x: String y: Int } type Query { a: A }';
    const newSdl = 'type A { x: String } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'field_removed', schema: 'A', property: 'y' }),
    );
  });

  it('detects renamed fields', async () => {
    const oldSdl = 'type A { user_id: String } type Query { a: A }';
    const newSdl = 'type A { userId: String } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({
        type: 'property_renamed',
        schema: 'A',
        property: 'user_id',
        newProperty: 'userId',
      }),
    );
  });

  it('detects field type changes', async () => {
    const oldSdl = 'type A { status: String } type Query { a: A }';
    const newSdl = 'type A { status: Int } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({
        type: 'field_type_changed',
        schema: 'A',
        property: 'status',
        oldType: 'String',
        newType: 'Int',
      }),
    );
  });

  it('detects non-null tightening as a breaking type change', async () => {
    const oldSdl = 'type A { x: String } type Query { a: A }';
    const newSdl = 'type A { x: String! } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes.some(c => c.type === 'field_type_changed' && c.property === 'x')).toBe(true);
  });

  it('detects removed enum values', async () => {
    const oldSdl = 'enum S { A B } type Query { status: S }';
    const newSdl = 'enum S { A } type Query { status: S }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'enum_value_removed', schema: 'S', property: 'B' }),
    );
  });

  it('flags newly deprecated fields as risky', async () => {
    const oldSdl = 'type A { x: String } type Query { a: A }';
    const newSdl = 'type A { x: String @deprecated(reason: "use y") } type Query { a: A }';

    const changes = await engine.compare(oldSdl, newSdl);
    expect(changes).toContainEqual(
      expect.objectContaining({
        type: 'field_deprecated',
        schema: 'A',
        property: 'x',
        severity: 'risky',
      }),
    );
  });

  it('treats added fields as non-breaking', async () => {
    const oldSdl = 'type A { x: String } type Query { a: A }';
    const newSdl = 'type A { x: String added: Boolean } type Query { a: A }';

    expect(await engine.compare(oldSdl, newSdl)).toHaveLength(0);
  });

  it('compares SDL from local files', async () => {
    const changes = await engine.compare(
      fixture('payments-old.graphql'),
      fixture('payments-new.graphql'),
    );

    // amount removed; user_id → userId renamed; REFUNDED enum value removed; expMonth added.
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'field_removed', schema: 'Payment', property: 'amount' }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        type: 'property_renamed',
        schema: 'Payment',
        property: 'user_id',
        newProperty: 'userId',
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        type: 'enum_value_removed',
        schema: 'PaymentStatus',
        property: 'REFUNDED',
      }),
    );
  });

  it('throws on malformed SDL', async () => {
    await expect(engine.compare('this is not { graphql', 'type A { x: String }')).rejects.toThrow();
  });
});
