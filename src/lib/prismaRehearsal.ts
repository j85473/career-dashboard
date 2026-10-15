/** Fail closed when a rehearsal command is pointed outside its private copy. */
export function assertPrismaRehearsalUrl(databaseUrl: string, runtimeHost?: string): void {
  const url = new URL(databaseUrl);
  const host = runtimeHost?.trim() || url.hostname;
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost'].includes(host)
    || url.port !== '55433'
    || url.pathname !== '/career_prisma7'
    || url.username !== 'career_prisma7') {
    throw new Error('Prisma rehearsal requires the isolated career_prisma7 database on loopback port 55433.');
  }
}
