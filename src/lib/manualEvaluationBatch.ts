type JsonRecord = Record<string, unknown>;

export interface VersionedEntries {
  ids: string[];
  versions: Map<string, string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function parseVersionedEntries(payload: JsonRecord, field: string): VersionedEntries {
  const entries = payload[field];
  if (!Array.isArray(entries)) {
    throw new Error(`${field} must be an array with optimistic versions`);
  }

  const ids: string[] = [];
  const versions = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error(`${field} entries must contain a non-empty id`);
    }
    if (typeof entry.submittedUpdatedAt !== 'string' || !isCanonicalIsoTimestamp(entry.submittedUpdatedAt)) {
      throw new Error(`${field} entry ${entry.id} must contain the exported submittedUpdatedAt timestamp`);
    }
    if (versions.has(entry.id)) {
      throw new Error(`${field} contains duplicate id ${entry.id}`);
    }
    ids.push(entry.id);
    versions.set(entry.id, entry.submittedUpdatedAt);
  }
  return { ids, versions };
}

export function parseContextProfileVersion(payload: JsonRecord): string | null {
  if (!Object.prototype.hasOwnProperty.call(payload, 'submittedContextProfileUpdatedAt')) {
    throw new Error('submittedContextProfileUpdatedAt is required');
  }
  const version = payload.submittedContextProfileUpdatedAt;
  if (version === null) return null;
  if (typeof version !== 'string' || !isCanonicalIsoTimestamp(version)) {
    throw new Error('submittedContextProfileUpdatedAt must be the exported timestamp or null');
  }
  return version;
}

export function versionsMatch(
  current: Array<{ id: string; updatedAt: Date }>,
  submitted: VersionedEntries,
): boolean {
  if (current.length !== submitted.ids.length) return false;
  const currentById = new Map(current.map((entry) => [entry.id, entry.updatedAt.toISOString()]));
  return submitted.ids.every((id) => currentById.get(id) === submitted.versions.get(id));
}
