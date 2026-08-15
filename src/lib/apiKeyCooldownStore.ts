import crypto from 'node:crypto';
import { prisma } from './prisma';

/**
 * Durable per-key rate-limit cooldowns.
 *
 * The in-memory map these back was lost on every restart, so the next call
 * re-tried all thirteen keys to rediscover each was exhausted — thirteen real
 * requests spent learning nothing, repeated on every deploy and crash. A
 * RapidAPI quota window is twelve days; it should be learned once.
 */
export type KeyCooldownStore = {
  load: (service: string) => Promise<Map<string, number>>;
  save: (service: string, key: string, readyAt: number, reason: string) => Promise<void>;
};

/** The value never needs reading back, only matching, so only a hash is kept. */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function schemaUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'P2021' || code === 'P2022';
}

export const prismaKeyCooldownStore: KeyCooldownStore = {
  async load(service) {
    const cooldowns = new Map<string, number>();
    try {
      const rows = await prisma.apiKeyCooldown.findMany({
        where: { service, readyAt: { gt: new Date() } },
        select: { keyHash: true, readyAt: true },
      });
      for (const row of rows) cooldowns.set(row.keyHash, row.readyAt.getTime());
    } catch (error) {
      // A pre-migration database must not stop ingestion; it just loses the
      // durability and behaves as the in-memory version always did.
      if (!schemaUnavailable(error)) throw error;
    }
    return cooldowns;
  },

  async save(service, key, readyAt, reason) {
    const keyHash = hashApiKey(key);
    const data = { readyAt: new Date(readyAt), reason: reason.slice(0, 200) };
    try {
      await prisma.apiKeyCooldown.upsert({
        where: { service_keyHash: { service, keyHash } },
        update: data,
        create: { service, keyHash, ...data },
      });
    } catch (error) {
      if (!schemaUnavailable(error)) throw error;
    }
  },
};
