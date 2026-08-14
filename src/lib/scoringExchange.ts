import { TextDecoder } from 'node:util';

import aimExportV1Schema from '../../data/scoring/schemas/aim-export-v1.schema.json';
import aimResultV1Schema from '../../data/scoring/schemas/aim-result-v1.schema.json';
import aimExportV2Schema from '../../data/scoring/schemas/aim-export-v2.schema.json';
import aimResultV2Schema from '../../data/scoring/schemas/aim-result-v2.schema.json';
import aimFactualVectorSchema from '../../data/scoring/schemas/aim-factual-vector-v1.schema.json';
import experienceExportV1Schema from '../../data/scoring/schemas/experience-export-v1.schema.json';
import experienceResultV1Schema from '../../data/scoring/schemas/experience-result-v1.schema.json';
import experienceExportV2Schema from '../../data/scoring/schemas/experience-export-v2.schema.json';
import experienceResultV2Schema from '../../data/scoring/schemas/experience-result-v2.schema.json';

import {
  aimBatchItemInputHash,
  aimExtractionIdentity,
  aimResultEnvelopeHash,
  aimResultItemHash,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
} from './aimIdentity';
import { assertIntegerJson, canonicalJson, canonicalJsonSha256, normalizeScoringText } from './scoringCanonicalJson';
import { validateJsonSchema, type JsonSchema } from './scoringJsonSchema';
import { aimV2ManifestHash, scoringManifestHash, type ScoringStage } from './scoringInputBinding';

export const MAX_SCORING_EXCHANGE_BYTES = 32 * 1024 * 1024;
export const MAX_AIM_V2_RESULT_BYTES = 31_000_000;
export const MAX_AIM_V2_RESULT_ITEM_BYTES = 1_500_000;
export const MAX_AIM_V2_UNIQUE_EVIDENCE_CODE_POINTS = 160_000;
export const SCORING_PROTOCOL_V1 = 'career-dashboard-scoring-protocol-v1';
export const SCORING_PROTOCOL_V2 = 'career-dashboard-scoring-protocol-v2';
/** Historical alias retained only for v1 callers while v2 cutover is staged. */
export const SCORING_PROTOCOL_VERSION = SCORING_PROTOCOL_V1;

export type ScoringExchangeRecord = Record<string, unknown>;

const SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  'career-dashboard-aim-export-v1': aimExportV1Schema as JsonSchema,
  'career-dashboard-aim-result-v1': aimResultV1Schema as JsonSchema,
  'career-dashboard-aim-export-v2': aimExportV2Schema as JsonSchema,
  'career-dashboard-aim-result-v2': aimResultV2Schema as JsonSchema,
  'career-dashboard-experience-export-v1': experienceExportV1Schema as JsonSchema,
  'career-dashboard-experience-result-v1': experienceResultV1Schema as JsonSchema,
  'career-dashboard-experience-export-v2': experienceExportV2Schema as JsonSchema,
  'career-dashboard-experience-result-v2': experienceResultV2Schema as JsonSchema,
};

const EXTERNAL_SCHEMAS = new Map<string, JsonSchema>([
  ['career-dashboard-aim-factual-vector-v1', aimFactualVectorSchema as JsonSchema],
]);

function isRecord(value: unknown): value is ScoringExchangeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, message: string): ScoringExchangeRecord {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

function validateOrderedMembers(value: ScoringExchangeRecord): void {
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

function validateAimV2ExportBindings(value: ScoringExchangeRecord): void {
  const batch = requiredRecord(value.batch, 'Aim v2 export batch is required');
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  for (const [index, raw] of jobs.entries()) {
    const job = requiredRecord(raw, `Aim v2 export job ${index} is invalid`);
    const source = requiredRecord(job.source, `Aim v2 export source ${index} is invalid`);
    const metadata = requiredRecord(job.trustedMetadata, `Aim v2 trusted metadata ${index} is invalid`);
    const originalJd = requiredString(source.originalJd, `Aim v2 original JD ${index} is invalid`);
    if (originalJd !== normalizeScoringText(originalJd)) throw new Error(`Aim v2 original JD ${index} is not canonical text`);
    const sourceJdHash = aimSourceJdHash(originalJd);
    if (source.sourceJdHash !== sourceJdHash) throw new Error(`Aim v2 source JD hash mismatch at ordinal ${index}`);
    const trustedMetadata = {
      company: requiredString(metadata.company, 'Aim trusted company is required'),
      title: requiredString(metadata.title, 'Aim trusted title is required'),
      location: metadata.location === null ? null : requiredString(metadata.location, 'Aim trusted location is invalid'),
    };
    const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
    if (job.trustedMetadataHash !== trustedMetadataHash) throw new Error(`Aim v2 trusted metadata hash mismatch at ordinal ${index}`);
    const sourceIdentity = aimSourceIdentity(sourceJdHash, trustedMetadataHash);
    if (job.sourceIdentity !== sourceIdentity) throw new Error(`Aim v2 source identity mismatch at ordinal ${index}`);
    const extractionIdentity = aimExtractionIdentity({
      sourceIdentity,
      questionRegistryVersion: requiredString(batch.questionRegistryVersion, 'Aim question registry version is required'),
      questionRegistryHash: requiredString(batch.questionRegistryHash, 'Aim question registry hash is required'),
      promptContractVersion: requiredString(batch.promptContractVersion, 'Aim prompt contract version is required'),
      promptContractHash: requiredString(batch.promptContractHash, 'Aim prompt contract hash is required'),
      responseContractVersion: requiredString(batch.responseContractVersion, 'Aim response contract version is required'),
      responseContractHash: requiredString(batch.responseContractHash, 'Aim response contract hash is required'),
      packetStrategyVersion: requiredString(batch.packetStrategyVersion, 'Aim packet strategy version is required'),
      packetStrategyHash: requiredString(batch.packetStrategyHash, 'Aim packet strategy hash is required'),
      canonicalizationVersion: requiredString(batch.canonicalizationVersion, 'Aim canonicalization version is required'),
      anonymizationPolicyVersion: requiredString(batch.anonymizationPolicyVersion, 'Aim anonymization policy version is required'),
      anonymizationPolicyHash: requiredString(batch.anonymizationPolicyHash, 'Aim anonymization policy hash is required'),
      extractorSemanticVersion: requiredString(batch.extractorSemanticVersion, 'Aim extractor semantic version is required'),
    });
    if (job.extractionIdentity !== extractionIdentity) throw new Error(`Aim v2 extraction identity mismatch at ordinal ${index}`);
    const inputHash = aimBatchItemInputHash({
      protocolVersion: requiredString(batch.protocolVersion, 'Aim protocol version is required'),
      exportSchemaVersion: requiredString(batch.exportSchemaVersion, 'Aim export schema version is required'),
      sourceIdentity,
      extractionIdentity,
      scoringPolicyHash: requiredString(batch.scoringPolicyHash, 'Aim scoring policy hash is required'),
      runnerProtocolHash: requiredString(batch.runnerProtocolHash, 'Aim runner protocol hash is required'),
    });
    if (job.inputHash !== inputHash) throw new Error(`Aim v2 input hash mismatch at ordinal ${index}`);
  }
}

function validateExperienceV2ExportBindings(value: ScoringExchangeRecord): void {
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  for (const [index, raw] of jobs.entries()) {
    const job = requiredRecord(raw, `Experience v2 export job ${index} is invalid`);
    const metadata = requiredRecord(job.trustedMetadata, `Experience v2 trusted metadata ${index} is invalid`);
    const originalJd = requiredString(job.originalJd, `Experience v2 original JD ${index} is invalid`);
    if (originalJd !== normalizeScoringText(originalJd)) {
      throw new Error(`Experience v2 original JD ${index} is not canonical text`);
    }
    const sourceJdHash = aimSourceJdHash(originalJd);
    if (job.sourceJdHash !== sourceJdHash) throw new Error(`Experience v2 source JD hash mismatch at ordinal ${index}`);
    const trustedMetadata = {
      company: requiredString(metadata.company, 'Experience trusted company is required'),
      title: requiredString(metadata.title, 'Experience trusted title is required'),
      location: metadata.location === null ? null : requiredString(metadata.location, 'Experience trusted location is invalid'),
    };
    const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
    if (job.trustedMetadataHash !== trustedMetadataHash) {
      throw new Error(`Experience v2 trusted metadata hash mismatch at ordinal ${index}`);
    }
  }
}

function validateAimV2ResultBounds(value: ScoringExchangeRecord, bytes: number): void {
  if (bytes > MAX_AIM_V2_RESULT_BYTES) throw new Error('Aim v2 result exceeds its 31,000,000-byte contract');
  const controller = requiredRecord(value.controller, 'Aim v2 controller provenance is required');
  const batch = requiredRecord(value.batch, 'Aim v2 result batch is required');
  if (controller.controllerVersion !== 'career-dashboard-aim-controller-v5'
    || controller.promptContractVersion !== batch.promptContractVersion
    || controller.responseContractVersion !== batch.responseContractVersion) {
    throw new Error('Aim v2 controller authority binding is inconsistent');
  }
  const controllerStarted = Date.parse(requiredString(controller.startedAt, 'Aim controller startedAt is required'));
  const controllerCompleted = Date.parse(requiredString(controller.completedAt, 'Aim controller completedAt is required'));
  if (!Number.isFinite(controllerStarted) || !Number.isFinite(controllerCompleted)
    || controllerCompleted < controllerStarted) {
    throw new Error('Aim v2 controller timestamps are inconsistent');
  }
  const results = Array.isArray(value.results) ? value.results : [];
  let workerCount = 0;
  const allWorkers: ScoringExchangeRecord[] = [];
  for (const [index, raw] of results.entries()) {
    const item = requiredRecord(raw, `Aim v2 result item ${index} is invalid`);
    if (Buffer.byteLength(canonicalJson(item), 'utf8') > MAX_AIM_V2_RESULT_ITEM_BYTES) {
      throw new Error(`Aim v2 result item ${index} exceeds its per-job byte contract`);
    }
    const workers = Array.isArray(item.workers) ? item.workers : [];
    workerCount += workers.length;
    for (const [workerIndex, rawWorker] of workers.entries()) {
      const worker = requiredRecord(rawWorker, `Aim v2 worker ${index}.${workerIndex} is invalid`);
      const started = Date.parse(requiredString(worker.startedAt, 'Aim worker startedAt is required'));
      const completed = Date.parse(requiredString(worker.completedAt, 'Aim worker completedAt is required'));
      if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started
        || started < controllerStarted || completed > controllerCompleted) {
        throw new Error(`Aim v2 worker ${index}.${workerIndex} timestamps are inconsistent`);
      }
      allWorkers.push(worker);
    }
    const result = requiredRecord(item.result, `Aim v2 semantic result ${index} is invalid`);
    const vector = isRecord(result.factualVector) ? result.factualVector : null;
    if (vector) {
      if (item.extractionIdentity !== vector.extractionIdentity) throw new Error(`Aim v2 extraction binding mismatch at ordinal ${index}`);
      const catalog = Array.isArray(vector.evidenceCatalog) ? vector.evidenceCatalog : [];
      const evidenceCodePoints = catalog.reduce((total, entry) => (
        total + (isRecord(entry) && typeof entry.exactQuote === 'string' ? [...entry.exactQuote].length : 0)
      ), 0);
      if (evidenceCodePoints > MAX_AIM_V2_UNIQUE_EVIDENCE_CODE_POINTS) {
        throw new Error(`Aim v2 evidence catalog exceeds its code-point contract at ordinal ${index}`);
      }
      const provenance = requiredRecord(vector.provenance, `Aim v2 vector provenance ${index} is invalid`);
      const packets = Array.isArray(provenance.packets) ? provenance.packets.map((packet) => (
        requiredRecord(packet, `Aim v2 vector packet ${index} is invalid`)
      )) : [];
      const packetsByManifest = new Map(packets.map((packet) => [packet.packetManifestHash, packet]));
      const normalizedWorkers = workers.map((entry) => requiredRecord(entry, 'Aim v2 worker is invalid'));
      const factualWorkers = normalizedWorkers.filter((worker) => worker.effort === 'medium');
      const holisticWorkers = normalizedWorkers.filter((worker) => worker.effort === 'high');
      for (const worker of factualWorkers) {
        const packet = packetsByManifest.get(worker.packetManifestHash);
        if (!packet) throw new Error(`Aim v2 worker packet binding is missing at ordinal ${index}`);
      }
      const expectedHolisticWorkers = result.variant === 'scored_survivor' ? 1 : 0;
      if (holisticWorkers.length !== expectedHolisticWorkers
        || holisticWorkers.some((worker) => packetsByManifest.has(worker.packetManifestHash))) {
        throw new Error(`Aim v2 holistic worker binding is invalid at ordinal ${index}`);
      }
    }
  }
  if (controller.totalModelCalls !== workerCount) throw new Error('Aim v2 controller model-call count does not match worker receipts');
  const models = Array.isArray(controller.models)
    ? controller.models.map((entry) => requiredRecord(entry, 'Aim controller model provenance is invalid'))
    : [];
  if ((workerCount === 0) !== (models.length === 0)) throw new Error('Aim v2 controller model provenance is inconsistent with its call count');
  if (workerCount > 0) {
    const modelNames = new Set(models.map((entry) => entry.model));
    if (modelNames.size !== 1) throw new Error('Aim v2 production controller must use one selected model');
    const selectedModel = requiredString(models[0].model, 'Aim controller selected model is invalid');
    const seenEfforts = new Set<string>();
    const expectedModels = allWorkers.flatMap((worker) => {
      const effort = requiredString(worker.effort, 'Aim worker effort is invalid');
      if (seenEfforts.has(effort)) return [];
      seenEfforts.add(effort);
      return [{ model: selectedModel, effort }];
    });
    if (canonicalJson(models) !== canonicalJson(expectedModels)) {
      throw new Error('Aim v2 controller model/effort provenance does not match worker receipts');
    }
    for (const [index, raw] of results.entries()) {
      const item = requiredRecord(raw, `Aim v2 result item ${index} is invalid`);
      const result = requiredRecord(item.result, `Aim v2 semantic result ${index} is invalid`);
      const vector = isRecord(result.factualVector) ? result.factualVector : null;
      if (!vector) continue;
      const provenance = requiredRecord(vector.provenance, `Aim v2 vector provenance ${index} is invalid`);
      const packets = Array.isArray(provenance.packets) ? provenance.packets : [];
      const packetModels = new Map(packets.map((packet) => {
        const value = requiredRecord(packet, `Aim v2 packet provenance ${index} is invalid`);
        return [value.packetManifestHash, value.model];
      }));
      for (const rawWorker of Array.isArray(item.workers) ? item.workers : []) {
        const worker = requiredRecord(rawWorker, 'Aim v2 worker is invalid');
        if (worker.effort === 'high') continue;
        if (packetModels.get(worker.packetManifestHash) !== selectedModel) {
          throw new Error(`Aim v2 worker model does not match its packet at ordinal ${index}`);
        }
      }
    }
  }
  const expectedReceipt = `aim-two-stage-calls:${workerCount};run:${requiredString(batch.id, 'Aim batch ID is required')}`;
  if (controller.invocationReceipt !== expectedReceipt) {
    throw new Error('Aim v2 controller invocation receipt does not bind its batch and call count');
  }
}

function validateHashes(value: ScoringExchangeRecord): void {
  const version = String(value.schemaVersion);
  if (typeof value.resultHash === 'string') {
    const { resultHash, ...withoutResultHash } = value;
    const expected = version === 'career-dashboard-aim-result-v2'
      ? aimResultEnvelopeHash(withoutResultHash)
      : canonicalJsonSha256(withoutResultHash);
    if (expected !== resultHash) throw new Error('full-file resultHash mismatch');
  }
  const results = Array.isArray(value.results) ? value.results : [];
  for (const item of results) {
    if (!isRecord(item) || typeof item.resultHash !== 'string') continue;
    const { resultHash, ...withoutResultHash } = item;
    const expected = version === 'career-dashboard-aim-result-v2'
      ? aimResultItemHash(withoutResultHash)
      : canonicalJsonSha256(withoutResultHash);
    if (expected !== resultHash) throw new Error(`resultHash mismatch for ${String(item.jobId)}`);
  }
}

export function parseScoringExchangeJson(input: string | Buffer): ScoringExchangeRecord {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength > MAX_SCORING_EXCHANGE_BYTES) throw new Error('scoring exchange exceeds 32 MiB');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('scoring exchange is not valid UTF-8 JSON');
  }
  if (!isRecord(value) || typeof value.schemaVersion !== 'string') throw new Error('scoring exchange schemaVersion is required');
  const schema = SCHEMAS[value.schemaVersion];
  if (!schema) throw new Error(`unknown scoring exchange schemaVersion ${value.schemaVersion}`);
  assertIntegerJson(value);
  validateJsonSchema(value, schema, { externalSchemas: EXTERNAL_SCHEMAS });
  validateOrderedMembers(value);
  validateHashes(value);
  if (value.schemaVersion === 'career-dashboard-aim-export-v2') validateAimV2ExportBindings(value);
  if (value.schemaVersion === 'career-dashboard-experience-export-v2') validateExperienceV2ExportBindings(value);
  if (value.schemaVersion === 'career-dashboard-aim-result-v2') {
    validateAimV2ResultBounds(value, Buffer.byteLength(canonicalJson(value), 'utf8'));
  }
  return value;
}

export function validateExportManifest(value: ScoringExchangeRecord): void {
  const batch = requiredRecord(value.batch, 'export batch is required');
  if (!Array.isArray(value.jobs)) throw new Error('export jobs are required');
  const items = value.jobs.map((raw) => {
    const item = requiredRecord(raw, 'export job must be an object');
    return { ordinal: Number(item.ordinal), jobId: String(item.jobId), inputHash: String(item.inputHash) };
  });
  const expected = value.schemaVersion === 'career-dashboard-aim-export-v2'
    ? aimV2ManifestHash({
      batchId: String(batch.id),
      protocolVersion: String(batch.protocolVersion),
      exportSchemaVersion: String(batch.exportSchemaVersion),
      scoringPolicyVersion: String(batch.scoringPolicyVersion),
      questionRegistryHash: String(batch.questionRegistryHash),
      promptContractHash: String(batch.promptContractHash),
      responseContractHash: String(batch.responseContractHash),
      packetStrategyHash: String(batch.packetStrategyHash),
      items,
    })
    : scoringManifestHash({
      batchId: String(batch.id),
      stage: batch.stage as ScoringStage,
      schemaVersion: String(value.schemaVersion),
      protocolVersion: String(batch.protocolVersion),
      policyVersion: String(batch.policyVersion),
      items,
    });
  if (batch.manifestHash !== expected) throw new Error('export manifestHash mismatch');
}

export function validateResultAgainstExport(result: ScoringExchangeRecord, exported: ScoringExchangeRecord): void {
  validateExportManifest(exported);
  const resultBatch = requiredRecord(result.batch, 'result batch is required');
  const exportBatch = requiredRecord(exported.batch, 'export batch is required');
  if (!Array.isArray(result.results) || !Array.isArray(exported.jobs)) throw new Error('result/export envelope is incomplete');
  const resultItems = result.results;
  const exportedJobs = exported.jobs;
  const version = String(result.schemaVersion);
  const keys = version === 'career-dashboard-aim-result-v2'
    ? [
      'id', 'stage', 'protocolVersion', 'exportSchemaVersion', 'manifestHash',
      'questionRegistryVersion', 'questionRegistryHash', 'scoringPolicyVersion', 'scoringPolicyHash',
      'resultBuilderSemanticVersion', 'promptContractVersion', 'promptContractHash',
      'responseContractVersion', 'responseContractHash', 'runnerProtocolVersion', 'runnerProtocolHash',
      'packetStrategyVersion', 'packetStrategyHash', 'canonicalizationVersion',
      'anonymizationPolicyVersion', 'anonymizationPolicyHash', 'extractorSemanticVersion',
    ]
    : version === 'career-dashboard-experience-result-v2'
      ? ['id', 'stage', 'protocolVersion', 'exportSchemaVersion', 'policyVersion', 'manifestHash']
      : ['id', 'stage', 'protocolVersion', 'policyVersion', 'manifestHash'];
  for (const key of keys) if (resultBatch[key] !== exportBatch[key]) throw new Error(`result batch ${key} mismatch`);
  if (version === 'career-dashboard-experience-result-v2') {
    const resume = requiredRecord(exported.resume, 'Experience export resume is required');
    const evidence = requiredRecord(exported.evidence, 'Experience export evidence is required');
    if (result.resumeHash !== resume.hash) throw new Error('Experience v2 result resumeHash mismatch');
    if (result.evidenceHash !== evidence.evidenceHash) throw new Error('Experience v2 result evidenceHash mismatch');
  }
  if (resultItems.length !== exportedJobs.length) throw new Error('result has partial or extra membership');
  resultItems.forEach((raw, index) => {
    const item = requiredRecord(raw, `result item ${index} is invalid`);
    const source = requiredRecord(exportedJobs[index], `export job ${index} is invalid`);
    if (item.jobId !== source.jobId || item.ordinal !== source.ordinal || item.inputHash !== source.inputHash) {
      throw new Error(`result membership mismatch at ordinal ${index}`);
    }
    if (version === 'career-dashboard-aim-result-v2') {
      const exportSource = requiredRecord(source.source, `Aim export source ${index} is invalid`);
      if (item.sourceJdHash !== exportSource.sourceJdHash || item.trustedMetadataHash !== source.trustedMetadataHash) {
        throw new Error(`Aim v2 result source binding mismatch at ordinal ${index}`);
      }
    }
    if (version === 'career-dashboard-experience-result-v2') {
      for (const key of ['sourceAimEventId', 'aimFactualExtractionId', 'sourceJdHash', 'aimSemanticResultHash']) {
        if (item[key] !== source[key]) throw new Error(`Experience v2 result ${key} mismatch at ordinal ${index}`);
      }
    }
  });
}
