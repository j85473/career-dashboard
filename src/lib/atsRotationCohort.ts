import { Prisma } from './prismaClient';
import { ATS_DAILY_BOARDS } from './atsRotation';

export function atsRotationCohortWhere(day: number): Prisma.AtsCompanyWhereInput {
  return { OR: [{ checkDay: day }, ...ATS_DAILY_BOARDS] };
}

/** The surrounding SQL uses `board` as its AtsCompany alias. */
export function atsRotationCohortSql(day: number | Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(board."checkDay" = ${day} OR (${Prisma.join(ATS_DAILY_BOARDS.map((daily) => (
    Prisma.sql`(board.slug = ${daily.slug} AND board.platform = ${daily.platform})`
  )), ' OR ')}))`;
}
