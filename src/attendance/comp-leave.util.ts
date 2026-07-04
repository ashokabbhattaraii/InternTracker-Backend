import { PrismaService } from "../prisma/prisma.service";

export type CompLeave = {
  earned: number;
  used: number;
  balance: number;
  earningSaturdays: string[];
};

export const EMPTY_COMP_LEAVE: CompLeave = {
  earned: 0,
  used: 0,
  balance: 0,
  earningSaturdays: [],
};

const key = (internId: string, date: Date): string =>
  `${internId}|${date.toISOString().split("T")[0]}`;

// ---------------------------------------------------------------------------
// Comp-leave engine — lifetime, accumulating (balance = earned − used).
//   earned = rostered Saturdays the intern was present (manual P, or a call-log
//            submission that day; a manual non-P status overrides derived P).
//   used   = attendance days marked CL (approved CL leaves also write CL here).
// ---------------------------------------------------------------------------
export async function computeCompLeave(
  prisma: PrismaService,
  internIds?: string[],
): Promise<Map<string, CompLeave>> {
  const filter = internIds ? { internId: { in: internIds } } : {};
  // The DB is remote (~150ms RTT), so keep sequential round trips to a minimum:
  // stage 1 fetches rosters + CL-used together, stage 2 the Saturday evidence.
  const [rosters, used] = await Promise.all([
    prisma.saturdayRoster.findMany({ where: filter }),
    prisma.attendance.groupBy({
      by: ["internId"],
      where: { status: "CL", ...(internIds ? { internId: { in: internIds } } : {}) },
      _count: { _all: true },
    }),
  ]);

  const result = new Map<string, CompLeave>();
  if (rosters.length === 0) return applyUsed(result, used);

  const satDates = [...new Set(rosters.map((r) => r.date.getTime()))].map((t) => new Date(t));

  const [manualOnSat, logsOnSat] = await Promise.all([
    prisma.attendance.findMany({
      where: { date: { in: satDates }, ...filter },
      select: { internId: true, date: true, status: true },
    }),
    prisma.callLog.findMany({
      where: { date: { in: satDates }, ...filter },
      select: { internId: true, date: true },
    }),
  ]);

  const manualSat = new Map<string, string>();
  for (const r of manualOnSat) manualSat.set(key(r.internId, r.date), r.status);
  const logSat = new Set<string>();
  for (const l of logsOnSat) logSat.add(key(l.internId, l.date));

  for (const r of rosters) {
    const k = key(r.internId, r.date);
    const manual = manualSat.get(k);
    const present = manual ? manual === "P" : logSat.has(k);
    const entry =
      result.get(r.internId) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };
    if (present) {
      entry.earned++;
      entry.earningSaturdays.push(r.date.toISOString().split("T")[0]);
    }
    result.set(r.internId, entry);
  }

  return applyUsed(result, used);
}

function applyUsed(
  result: Map<string, CompLeave>,
  used: Array<{ internId: string; _count: { _all: number } }>,
): Map<string, CompLeave> {
  for (const u of used) {
    const entry =
      result.get(u.internId) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };
    entry.used = u._count._all;
    result.set(u.internId, entry);
  }
  for (const entry of result.values()) entry.balance = entry.earned - entry.used;
  return result;
}
