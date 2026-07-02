import { Controller, Get, Post, Query, Body, Param } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// Statuses that count as "leave" for pattern detection / summaries.
const LEAVE_STATUSES = new Set(["AL", "HD", "CL", "UL"]);
const ABSENT_STATUSES = new Set(["A", "UL"]);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CompLeave = {
  earned: number;
  used: number;
  balance: number;
  earningSaturdays: string[];
};

@Controller("api/attendance")
export class AttendanceController {
  constructor(private prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Monthly grid. Effective status per intern/day:
  //   manual Attendance row  →  else derived "P" if a call log exists  →  else blank.
  // Also returns lifetime comp-leave (earned/used/balance) per intern.
  // ---------------------------------------------------------------------------
  @Get()
  async getGrid(@Query("month") month?: string, @Query("year") year?: string) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    const startDate = new Date(Date.UTC(y, m, 1));
    const endDate = new Date(Date.UTC(y, m + 1, 0));

    const interns = await this.prisma.intern.findMany({
      where: { active: true },
      orderBy: { internId: "asc" },
    });

    const [manual, callLogs, comp] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { internId: true, date: true, status: true },
      }),
      this.prisma.callLog.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { internId: true, date: true },
      }),
      this.computeCompLeave(),
    ]);

    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(this.key(r.internId, r.date), r.status);
    const logSet = new Set<string>();
    for (const l of callLogs) logSet.add(this.key(l.internId, l.date));

    const grid = interns.map((intern) => {
      const days: Record<string, string> = {};
      const counts = { P: 0, A: 0, L: 0, leave: 0, marked: 0, presentish: 0 };

      for (let d = 1; d <= endDate.getUTCDate(); d++) {
        const dateStr = this.ds(y, m, d);
        const k = `${intern.id}|${dateStr}`;
        const status = manualMap.get(k) ?? (logSet.has(k) ? "P" : undefined);
        if (!status) continue;
        days[dateStr] = status;
        if (status === "ND") continue;
        counts.marked++;
        if (status === "P") counts.P++;
        if (status === "A") counts.A++;
        if (status === "L") counts.L++;
        if (LEAVE_STATUSES.has(status)) counts.leave++;
        if (status === "P" || status === "CL" || status === "AL") counts.presentish++;
      }

      const cl =
        comp.get(intern.id) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };
      return {
        id: intern.id,
        internId: intern.internId,
        name: intern.name,
        team: intern.team,
        days,
        present: counts.P,
        absent: counts.A,
        late: counts.L,
        leave: counts.leave,
        attendanceRate:
          counts.marked > 0 ? Math.round((counts.presentish / counts.marked) * 100) : 0,
        clEarned: cl.earned,
        clUsed: cl.used,
        clBalance: cl.balance,
      };
    });

    return { month: m + 1, year: y, daysInMonth: endDate.getUTCDate(), grid };
  }

  // ---------------------------------------------------------------------------
  // Comp-leave summary across all interns (lifetime, accumulating balance).
  // ---------------------------------------------------------------------------
  @Get("comp-leave")
  async compLeave() {
    const interns = await this.prisma.intern.findMany({
      where: { active: true },
      orderBy: { internId: "asc" },
    });
    const comp = await this.computeCompLeave();
    return interns.map((i) => {
      const cl = comp.get(i.id) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };
      return {
        id: i.id,
        internId: i.internId,
        name: i.name,
        team: i.team,
        clEarned: cl.earned,
        clUsed: cl.used,
        clBalance: cl.balance,
        eligibleExtraLeave: cl.balance > 0,
        earningSaturdays: cl.earningSaturdays,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Per-intern "advance preview": month status breakdown, CL balance + eligibility,
  // and leave-pattern flags (SRD §3.4.2).
  // ---------------------------------------------------------------------------
  @Get("intern/:id/preview")
  async internPreview(
    @Param("id") id: string,
    @Query("month") month?: string,
    @Query("year") year?: string,
  ) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    const startDate = new Date(Date.UTC(y, m, 1));
    const endDate = new Date(Date.UTC(y, m + 1, 0));

    const intern = await this.prisma.intern.findUnique({ where: { id } });
    if (!intern) return { error: "Intern not found" };

    const [manual, callLogs, comp] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { internId: id, date: { gte: startDate, lte: endDate } },
        select: { date: true, status: true },
      }),
      this.prisma.callLog.findMany({
        where: { internId: id, date: { gte: startDate, lte: endDate } },
        select: { date: true },
      }),
      this.computeCompLeave([id]),
    ]);

    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(r.date.toISOString().split("T")[0], r.status);
    const logSet = new Set(callLogs.map((l) => l.date.toISOString().split("T")[0]));

    const breakdown: Record<string, number> = {};
    const absencesByWeekday = new Map<number, number>();
    let leaveCount = 0;
    let unapprovedCount = 0;

    for (let d = 1; d <= endDate.getUTCDate(); d++) {
      const dateStr = this.ds(y, m, d);
      const status = manualMap.get(dateStr) ?? (logSet.has(dateStr) ? "P" : undefined);
      if (!status) continue;
      breakdown[status] = (breakdown[status] || 0) + 1;
      if (LEAVE_STATUSES.has(status)) leaveCount++;
      if (status === "UL") unapprovedCount++;
      if (ABSENT_STATUSES.has(status)) {
        const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
        absencesByWeekday.set(wd, (absencesByWeekday.get(wd) || 0) + 1);
      }
    }

    const cl = comp.get(id) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };

    const flags: string[] = [];
    for (const [wd, c] of absencesByWeekday) {
      if (c >= 2) flags.push(`Repeated absence on ${WEEKDAYS[wd]} (${c}×)`);
    }
    if (leaveCount >= 3) flags.push(`${leaveCount} leaves this month`);
    if (unapprovedCount > 1) flags.push(`Unapproved leave ${unapprovedCount}× this month`);
    if (cl.used > cl.earned) flags.push(`Comp leave overspent (used ${cl.used} / earned ${cl.earned})`);

    return {
      intern: { id: intern.id, internId: intern.internId, name: intern.name, team: intern.team },
      month: m + 1,
      year: y,
      breakdown,
      compLeave: {
        earned: cl.earned,
        used: cl.used,
        balance: cl.balance,
        eligibleExtraLeave: cl.balance > 0,
        earningSaturdays: cl.earningSaturdays,
      },
      flags,
    };
  }

  // ---------------------------------------------------------------------------
  // Saturday duty roster
  // ---------------------------------------------------------------------------
  @Get("roster")
  async getRoster(@Query("month") month?: string, @Query("year") year?: string) {
    const where: any = {};
    if (month && year) {
      const m = parseInt(month) - 1;
      const y = parseInt(year);
      where.date = { gte: new Date(Date.UTC(y, m, 1)), lte: new Date(Date.UTC(y, m + 1, 0)) };
    }
    const rows = await this.prisma.saturdayRoster.findMany({ where });
    return rows.map((r) => ({
      id: r.id,
      internId: r.internId,
      date: r.date.toISOString().split("T")[0],
    }));
  }

  @Post("roster")
  async setRoster(@Body() body: { internId: string; date: string; rostered: boolean }) {
    const date = new Date(`${body.date}T00:00:00Z`);
    if (body.rostered) {
      return this.prisma.saturdayRoster.upsert({
        where: { internId_date: { internId: body.internId, date } },
        update: {},
        create: { internId: body.internId, date },
      });
    }
    await this.prisma.saturdayRoster.deleteMany({ where: { internId: body.internId, date } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Mark / check-in
  // ---------------------------------------------------------------------------
  @Post()
  async markAttendance(
    @Body() body: { internId: string; date: string; status: string; notes?: string },
  ) {
    const date = new Date(`${body.date}T00:00:00Z`);

    let warning: string | null = null;
    if (body.status === "CL") {
      const existing = await this.prisma.attendance.findUnique({
        where: { internId_date: { internId: body.internId, date } },
      });
      if (existing?.status !== "CL") {
        const comp = await this.computeCompLeave([body.internId]);
        const balance = comp.get(body.internId)?.balance ?? 0;
        if (balance <= 0) {
          warning = "No comp-leave balance available — this CL exceeds earned comp leave.";
        }
      }
    }

    const record = await this.prisma.attendance.upsert({
      where: { internId_date: { internId: body.internId, date } },
      update: { status: body.status as any, notes: body.notes },
      create: { internId: body.internId, date, status: body.status as any, notes: body.notes },
    });
    return { ...record, warning };
  }

  @Post("check-in")
  async checkIn(@Body() body: { internId: string }) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return this.prisma.attendance.upsert({
      where: { internId_date: { internId: body.internId, date: today } },
      update: { checkIn: now, status: "P" },
      create: { internId: body.internId, date: today, status: "P", checkIn: now },
    });
  }

  // ---------------------------------------------------------------------------
  // Comp-leave engine — lifetime, accumulating (balance = earned − used).
  //   earned = rostered Saturdays the intern was present (manual P, or a call-log
  //            submission that day; a manual non-P status overrides derived P).
  //   used   = attendance days marked CL (approved CL leaves also write CL here).
  // ---------------------------------------------------------------------------
  private async computeCompLeave(internIds?: string[]): Promise<Map<string, CompLeave>> {
    const filter = internIds ? { internId: { in: internIds } } : {};
    const rosters = await this.prisma.saturdayRoster.findMany({ where: filter });

    const result = new Map<string, CompLeave>();
    if (rosters.length === 0) return this.applyUsed(result, internIds);

    const satDates = [...new Set(rosters.map((r) => r.date.getTime()))].map((t) => new Date(t));

    const [manualOnSat, logsOnSat] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { date: { in: satDates }, ...filter },
        select: { internId: true, date: true, status: true },
      }),
      this.prisma.callLog.findMany({
        where: { date: { in: satDates }, ...filter },
        select: { internId: true, date: true },
      }),
    ]);

    const manualSat = new Map<string, string>();
    for (const r of manualOnSat) manualSat.set(this.key(r.internId, r.date), r.status);
    const logSat = new Set<string>();
    for (const l of logsOnSat) logSat.add(this.key(l.internId, l.date));

    for (const r of rosters) {
      const k = this.key(r.internId, r.date);
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

    return this.applyUsed(result, internIds);
  }

  private async applyUsed(
    result: Map<string, CompLeave>,
    internIds?: string[],
  ): Promise<Map<string, CompLeave>> {
    const used = await this.prisma.attendance.groupBy({
      by: ["internId"],
      where: { status: "CL", ...(internIds ? { internId: { in: internIds } } : {}) },
      _count: { _all: true },
    });
    for (const u of used) {
      const entry =
        result.get(u.internId) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };
      entry.used = u._count._all;
      result.set(u.internId, entry);
    }
    for (const entry of result.values()) entry.balance = entry.earned - entry.used;
    return result;
  }

  // date helpers -- everything keyed on the UTC calendar day (yyyy-mm-dd)
  private key(internId: string, date: Date): string {
    return `${internId}|${date.toISOString().split("T")[0]}`;
  }

  private ds(y: number, m: number, d: number): string {
    return new Date(Date.UTC(y, m, d)).toISOString().split("T")[0];
  }
}
