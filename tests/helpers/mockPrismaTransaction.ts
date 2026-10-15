import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';

/** Prisma 7 exposes methods through a proxy; node:test requires a descriptor. */
export function mockPrismaTransaction<Implementation extends (...args: never[]) => unknown>(
  context: TestContext,
  client: PrismaClient,
  implementation: Implementation,
) {
  const descriptor = Object.getOwnPropertyDescriptor(client, '$transaction');
  if (!descriptor) {
    Object.defineProperty(client, '$transaction', {
      value: client.$transaction,
      configurable: true,
      writable: true,
    });
  }
  const mocked = context.mock.method(client, '$transaction', implementation as never);
  context.after(() => {
    mocked.mock.restore();
    if (!descriptor) Reflect.deleteProperty(client, '$transaction');
  });
  return mocked;
}
