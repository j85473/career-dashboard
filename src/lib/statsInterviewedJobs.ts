import { Prisma } from '@prisma/client';

/**
 * A job stays in this total after leaving Interviewing. UNION counts each job
 * once, including legacy current interviews without a recorded transition.
 */
export const interviewedJobCountSql = Prisma.sql`
  SELECT COUNT(*) FROM (
    SELECT "jobId" FROM "JobStatusHistory" WHERE status = 'interviewing'
    UNION
    SELECT id FROM "Job" WHERE status = 'interviewing'
  ) AS interviewed_jobs
`;
