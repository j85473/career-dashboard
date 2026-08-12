import aimExportSchema from '../../data/scoring/schemas/aim-export-v1.schema.json';
import aimResultSchema from '../../data/scoring/schemas/aim-result-v1.schema.json';
import experienceExportSchema from '../../data/scoring/schemas/experience-export-v1.schema.json';
import experienceResultSchema from '../../data/scoring/schemas/experience-result-v1.schema.json';

import { assertIntegerJson, canonicalJsonSha256 } from './scoringCanonicalJson';
import { scoringManifestHash, type ScoringStage } from './scoringInputBinding';

export const MAX_SCORING_EXCHANGE_BYTES = 32 * 1024 * 1024;
export const SCORING_PROTOCOL_VERSION = 'career-dashboard-scoring-protocol-v1';

type JsonRecord = Record<string, unknown>;
type JsonSchema = JsonRecord & { $defs?: Record<string, JsonSchema> };

const SCHEMAS: Record<string, JsonSchema> = {
  'career-dashboard-aim-export-v1': aimExportSchema as JsonSchema,
  'career-dashboard-aim-result-v1': aimResultSchema as JsonSchema,
  'career-dashboard-experience-export-v1': experienceExportSchema as JsonSchema,
  'career-dashboard-experience-result-v1': experienceResultSchema as JsonSchema,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported schema reference ${ref}`);
  const definition = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (!definition) throw new Error(`unknown schema reference ${ref}`);
  return definition;
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === type;
}

function validateSchema(value: unknown, schema: JsonSchema, root: JsonSchema, path = '$'): void {
  if (typeof schema.$ref === 'string') return validateSchema(value, resolveRef(root, schema.$ref), root, path);
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((child) => validateSchema(value, child as JsonSchema, root, path));
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((child) => {
      try { validateSchema(value, child as JsonSchema, root, path); return true; } catch { return false; }
    });
    if (!valid) throw new Error(`${path} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => {
      try { validateSchema(value, child as JsonSchema, root, path); return true; } catch { return false; }
    }).length;
    if (matches !== 1) throw new Error(`${path} must match exactly one allowed schema`);
  }
  if ('const' in schema && value !== schema.const) throw new Error(`${path} must equal ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} contains an unknown enum value`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, String(type)))) throw new Error(`${path} has the wrong type`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) throw new Error(`${path} is too short`);
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) throw new Error(`${path} is too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} has invalid format`);
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path} is not a UUID`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${path} is below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${path} exceeds maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    if (isRecord(schema.items)) value.forEach((item, index) => validateSchema(item, schema.items as JsonSchema, root, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === 'string' && !(key in value)) throw new Error(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) if (key in value) validateSchema(value[key], child, root, `${path}.${key}`);
  }
}

function validateOrderedMembers(value: JsonRecord): void {
  const list = Array.isArray(value.jobs) ? value.jobs : Array.isArray(value.results) ? value.results : null;
  if (!list) return;
  const ids = new Set<string>();
  list.forEach((item, index) => {
    if (!isRecord(item)) throw new Error(`member ${index} must be an object`);
    if (item.ordinal !== index) throw new Error(`member ${index} has an invalid ordinal`);
    if (typeof item.jobId !== 'string' || ids.has(item.jobId)) throw new Error(`member ${index} has a duplicate or invalid job ID`);
    ids.add(item.jobId);
  });
}

function validateHashes(value: JsonRecord): void {
  if (typeof value.resultHash === 'string') {
    const { resultHash, ...withoutResultHash } = value;
    if (canonicalJsonSha256(withoutResultHash) !== resultHash) throw new Error('full-file resultHash mismatch');
  }
  const results = Array.isArray(value.results) ? value.results : [];
  for (const item of results) {
    if (!isRecord(item) || typeof item.resultHash !== 'string') continue;
    const { resultHash, ...withoutResultHash } = item;
    if (canonicalJsonSha256(withoutResultHash) !== resultHash) throw new Error(`resultHash mismatch for ${String(item.jobId)}`);
  }
}

export function parseScoringExchangeJson(input: string | Buffer): JsonRecord {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength > MAX_SCORING_EXCHANGE_BYTES) throw new Error('scoring exchange exceeds 32 MiB');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('scoring exchange is not valid JSON'); }
  if (!isRecord(value) || typeof value.schemaVersion !== 'string') throw new Error('scoring exchange schemaVersion is required');
  const schema = SCHEMAS[value.schemaVersion];
  if (!schema) throw new Error(`unknown scoring exchange schemaVersion ${value.schemaVersion}`);
  assertIntegerJson(value);
  validateSchema(value, schema, schema);
  validateOrderedMembers(value);
  validateHashes(value);
  return value;
}

export function validateExportManifest(value: JsonRecord): void {
  if (!isRecord(value.batch) || !Array.isArray(value.jobs)) throw new Error('export batch and jobs are required');
  const stage = value.batch.stage as ScoringStage;
  const expected = scoringManifestHash({
    batchId: String(value.batch.id), stage, schemaVersion: String(value.schemaVersion),
    protocolVersion: String(value.batch.protocolVersion), policyVersion: String(value.batch.policyVersion),
    items: value.jobs.map((item) => {
      if (!isRecord(item)) throw new Error('export job must be an object');
      return { ordinal: Number(item.ordinal), jobId: String(item.jobId), inputHash: String(item.inputHash) };
    }),
  });
  if (value.batch.manifestHash !== expected) throw new Error('export manifestHash mismatch');
}

export function validateResultAgainstExport(result: JsonRecord, exported: JsonRecord): void {
  if (!isRecord(result.batch) || !isRecord(exported.batch) || !Array.isArray(result.results) || !Array.isArray(exported.jobs)) throw new Error('result/export envelope is incomplete');
  const exportedJobs = exported.jobs;
  for (const key of ['id', 'stage', 'protocolVersion', 'policyVersion', 'manifestHash']) {
    if (result.batch[key] !== exported.batch[key]) throw new Error(`result batch ${key} mismatch`);
  }
  if (result.results.length !== exportedJobs.length) throw new Error('result has partial or extra membership');
  result.results.forEach((item, index) => {
    const source = exportedJobs[index];
    if (!isRecord(item) || !isRecord(source) || item.jobId !== source.jobId || item.ordinal !== source.ordinal || item.inputHash !== source.inputHash) {
      throw new Error(`result membership mismatch at ordinal ${index}`);
    }
  });
}
