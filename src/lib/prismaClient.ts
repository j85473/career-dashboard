import { PrismaClient as GeneratedPrismaClient, type Prisma } from '../generated/prisma/client';
import { createPrismaAdapter } from './prismaAdapter';

export * from '../generated/prisma/client';

type ClientOptions = Partial<Prisma.PrismaClientOptionsWithAdapter> & {
  datasourceUrl?: string;
  datasources?: { db?: { url?: string } };
};

/** One adapter boundary for app clients, workers, and existing maintenance tools. */
export class PrismaClient extends GeneratedPrismaClient {
  constructor(options: ClientOptions = {}) {
    const { datasourceUrl, datasources, ...clientOptions } = options;
    const databaseUrl = datasourceUrl ?? datasources?.db?.url ?? process.env.DATABASE_URL
      ?? 'postgresql://build:build@127.0.0.1:1/build';
    super({
      ...clientOptions,
      adapter: clientOptions.adapter ?? createPrismaAdapter(databaseUrl, process.env.DATABASE_RUNTIME_HOST),
    });
  }
}
