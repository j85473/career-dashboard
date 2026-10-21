import { Prisma } from './prismaClient';
import { ATS_DAILY_BOARDS, ATS_API_ROTATION_DAYS, apiRotationCheckDays } from './atsRotation';

export function atsRotationCohortWhere(day: number): Prisma.AtsCompanyWhereInput {
  return { OR: [{ checkDay: { in: apiRotationCheckDays(day) } }, ...ATS_DAILY_BOARDS] };
}

/** The surrounding SQL uses `board` as its AtsCompany alias. */
export function atsRotationCohortSql(day: number | Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(MOD(board."checkDay", ${ATS_API_ROTATION_DAYS}) = ${day} OR (${Prisma.join(ATS_DAILY_BOARDS.map((daily) => (
    Prisma.sql`(board.slug = ${daily.slug} AND board.platform = ${daily.platform})`
  )), ' OR ')}))`;
}
