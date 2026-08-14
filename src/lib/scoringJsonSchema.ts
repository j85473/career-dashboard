import { canonicalJson } from './scoringCanonicalJson';

export type JsonSchema = Record<string, unknown> & { $defs?: Record<string, JsonSchema> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaRecord(value: unknown, path: string): JsonSchema {
  if (!isRecord(value)) throw new Error(`${path} is not a schema object`);
  return value as JsonSchema;
}

function resolveLocalRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported local schema reference ${ref}`);
  const definition = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (!definition) throw new Error(`unknown local schema reference ${ref}`);
  return definition;
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return Object.is(left, right);
  }
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  options: { externalSchemas?: ReadonlyMap<string, JsonSchema> } = {},
): void {
  const visit = (item: unknown, rule: JsonSchema, root: JsonSchema, path: string, depth: number): void => {
    if (depth > 64) throw new Error(`${path} exceeds schema recursion limit`);
    if (typeof rule.$ref === 'string') {
      const local = rule.$ref.startsWith('#/');
      const resolved = local ? resolveLocalRef(root, rule.$ref) : options.externalSchemas?.get(rule.$ref);
      if (!resolved) throw new Error(`unsupported schema reference ${rule.$ref}`);
      return visit(item, resolved, local ? root : resolved, path, depth + 1);
    }

    if (Array.isArray(rule.allOf)) {
      for (const child of rule.allOf) visit(item, schemaRecord(child, `${path}.allOf`), root, path, depth + 1);
    }
    if (Array.isArray(rule.anyOf)) {
      const matches = rule.anyOf.filter((child) => {
        try {
          visit(item, schemaRecord(child, `${path}.anyOf`), root, path, depth + 1);
          return true;
        } catch {
          return false;
        }
      });
      if (matches.length === 0) throw new Error(`${path} does not match any allowed schema`);
    }
    if (Array.isArray(rule.oneOf)) {
      const matches = rule.oneOf.filter((child) => {
        try {
          visit(item, schemaRecord(child, `${path}.oneOf`), root, path, depth + 1);
          return true;
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) throw new Error(`${path} must match exactly one allowed schema`);
    }

    if ('const' in rule && !sameJson(item, rule.const)) throw new Error(`${path} does not match its constant`);
    if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => sameJson(item, candidate))) {
      throw new Error(`${path} contains an unknown enum value`);
    }

    if (rule.type !== undefined) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some((type) => typeMatches(item, String(type)))) throw new Error(`${path} has the wrong type`);
    }

    if (typeof item === 'string') {
      const length = [...item].length;
      if (typeof rule.minLength === 'number' && length < rule.minLength) throw new Error(`${path} is too short`);
      if (typeof rule.maxLength === 'number' && length > rule.maxLength) throw new Error(`${path} is too long`);
      if (typeof rule.pattern === 'string' && !new RegExp(rule.pattern, 'u').test(item)) throw new Error(`${path} has invalid format`);
      if (rule.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) {
        throw new Error(`${path} is not a UUID`);
      }
    }

    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`${path} must be finite`);
      if (typeof rule.minimum === 'number' && item < rule.minimum) throw new Error(`${path} is below minimum`);
      if (typeof rule.maximum === 'number' && item > rule.maximum) throw new Error(`${path} exceeds maximum`);
    }

    if (Array.isArray(item)) {
      if (typeof rule.minItems === 'number' && item.length < rule.minItems) throw new Error(`${path} has too few items`);
      if (typeof rule.maxItems === 'number' && item.length > rule.maxItems) throw new Error(`${path} has too many items`);
      if (rule.uniqueItems === true) {
        const serialized = item.map((entry) => canonicalJson(entry));
        if (new Set(serialized).size !== serialized.length) throw new Error(`${path} contains duplicate items`);
      }
      const prefixItems = Array.isArray(rule.prefixItems) ? rule.prefixItems : [];
      prefixItems.forEach((child, index) => {
        if (index < item.length) visit(item[index], schemaRecord(child, `${path}.prefixItems[${index}]`), root, `${path}[${index}]`, depth + 1);
      });
      if (rule.items === false && item.length > prefixItems.length) throw new Error(`${path} contains extra tuple items`);
      if (isRecord(rule.items)) {
        item.forEach((entry, index) => visit(entry, rule.items as JsonSchema, root, `${path}[${index}]`, depth + 1));
      }
    }

    if (isRecord(item)) {
      const keys = Object.keys(item);
      if (typeof rule.minProperties === 'number' && keys.length < rule.minProperties) throw new Error(`${path} has too few properties`);
      if (typeof rule.maxProperties === 'number' && keys.length > rule.maxProperties) throw new Error(`${path} has too many properties`);
      const properties = isRecord(rule.properties) ? rule.properties : {};
      if (Array.isArray(rule.required)) {
        for (const key of rule.required) {
          if (typeof key === 'string' && !(key in item)) throw new Error(`${path}.${key} is required`);
        }
      }
      for (const key of keys) {
        const propertyRule = properties[key];
        if (propertyRule !== undefined) {
          visit(item[key], schemaRecord(propertyRule, `${path}.${key}`), root, `${path}.${key}`, depth + 1);
        } else if (rule.additionalProperties === false) {
          throw new Error(`${path}.${key} is not allowed`);
        } else if (isRecord(rule.additionalProperties)) {
          visit(item[key], rule.additionalProperties as JsonSchema, root, `${path}.${key}`, depth + 1);
        }
      }
    }
  };

  visit(value, schema, schema, '$', 0);
}
