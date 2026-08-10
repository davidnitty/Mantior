import {
  type GraphQLNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  buildSchema,
} from 'graphql';

// Structural union of ObjectField / InterfaceField / InputField so both
// object/interface (with args) and input-object fields map cleanly.
interface AnyGraphQLField {
  name: string;
  type: unknown;
  deprecationReason?: string;
  args?: ReadonlyArray<{ name: string; type: unknown }>;
}

export type GraphQLTypeKind = 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';

export interface GraphQLFieldModel {
  name: string;
  /** Stringified type, e.g. `String!`, `[Charge!]!`. */
  type: string;
  deprecationReason?: string;
  args: Array<{ name: string; type: string }>;
}

export interface GraphQLTypeModel {
  name: string;
  kind: GraphQLTypeKind;
  /** Field map for OBJECT / INTERFACE / INPUT_OBJECT types. */
  fields: Map<string, GraphQLFieldModel>;
  /** Value names for ENUM types. */
  values?: string[];
  /** Member type names for UNION types. */
  members?: string[];
}

export interface GraphQLSchemaModel {
  types: Map<string, GraphQLTypeModel>;
}

const GRAPHQL_BUILTIN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/**
 * Parse GraphQL SDL into a normalized, diff-friendly type model. Uses the
 * official `graphql` parser so malformed schemas surface a real error instead
 * of silently producing a bogus diff.
 */
export class GraphQLSchemaParser {
  parse(sdl: string): GraphQLSchemaModel {
    const schema = buildSchema(sdl);
    const types = new Map<string, GraphQLTypeModel>();

    for (const [name, namedType] of Object.entries(schema.getTypeMap())) {
      if (name.startsWith('__') || GRAPHQL_BUILTIN_SCALARS.has(name)) {
        continue;
      }
      types.set(name, this.mapType(name, namedType));
    }

    return { types };
  }

  private mapType(name: string, type: GraphQLNamedType): GraphQLTypeModel {
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
      const kind = isObjectType(type)
        ? 'OBJECT'
        : isInterfaceType(type)
          ? 'INTERFACE'
          : 'INPUT_OBJECT';
      return {
        name,
        kind,
        fields: this.mapFields(type.getFields() as Record<string, AnyGraphQLField>),
      };
    }

    if (isEnumType(type)) {
      return {
        name,
        kind: 'ENUM',
        fields: new Map(),
        values: type.getValues().map(value => value.name),
      };
    }

    if (isUnionType(type)) {
      return {
        name,
        kind: 'UNION',
        fields: new Map(),
        members: type.getTypes().map(t => t.name),
      };
    }

    return { name, kind: 'SCALAR', fields: new Map() };
  }

  private mapFields(fieldMap: Record<string, AnyGraphQLField>): Map<string, GraphQLFieldModel> {
    const fields = new Map<string, GraphQLFieldModel>();
    for (const [fieldName, field] of Object.entries(fieldMap)) {
      fields.set(fieldName, {
        name: fieldName,
        type: String(field.type),
        deprecationReason: field.deprecationReason ?? undefined,
        args: (field.args ?? []).map(argument => ({
          name: argument.name,
          type: String(argument.type),
        })),
      });
    }
    return fields;
  }
}
