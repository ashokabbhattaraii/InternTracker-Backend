import { Controller, Get, Post, Query, Body, Param } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { computeCompLeave, CompLeave } from "./comp-leave.util";

// Statuses that count as "leave" for pattern detection / summaries.
const LEAVE_STATUSES = new Set(["AL", "HD", "CL", "UL"]);
const ABSENT_STATUSES = new Set(["A", "UL"]);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

    const [manual, callLogs, rosters, comp, callFirst, attFirst] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { internId: true, date: true, status: true },
      }),
      this.prisma.callLog.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { internId: true, date: true },
      }),
      this.prisma.saturdayRoster.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { internId: true, date: true },
      }),
      this.computeCompLeave(),
      // Earliest activity per intern (all time) — used so we never count working
      // days before an intern actually started reporting as absences.
      this.prisma.callLog.groupBy({ by: ["internId"], _min: { date: true } }),
      this.prisma.attendance.groupBy({ by: ["internId"], _min: { date: true } }),
    ]);

    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(this.key(r.internId, r.date), r.status);
    const logSet = new Set<string>();
    for (const l of callLogs) logSet.add(this.key(l.internId, l.date));
    const rosterSet = new Set<string>();
    for (const r of rosters) rosterSet.add(this.key(r.internId, r.date));

    // First day each intern counts toward the rate: earliest of join date / first
    // call log / first manual attendance (as a yyyy-mm-dd string).
    const startByIntern = new Map<string, string>();
    const noteStart = (internId: string, date: Date | null) => {
      if (!date) return;
      const s = date.toISOString().split("T")[0];
      const cur = startByIntern.get(internId);
      if (!cur || s < cur) startByIntern.set(internId, s);
    };
    for (const c of callFirst) noteStart(c.internId, c._min.date ?? null);
    for (const a of attFirst) noteStart(a.internId, a._min.date ?? null);
    for (const i of interns) noteStart(i.id, i.joinDate ?? null);

    // The attendance rate is measured over working days that have actually
    // elapsed — never penalise interns for days still in the future. Saturday
    // (UTC weekday 6) is the weekly holiday, so it is a working day only for an
    // intern rostered for that specific Saturday.
    const todayStr = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
      .toISOString()
      .split("T")[0];

    const grid = interns.map((intern) => {
      const days: Record<string, string> = {};
      const counts = { P: 0, A: 0, L: 0, leave: 0 };
      let present = 0; // present-ish credit: P/L = 1, HD = 0.5
      let expected = 0; // elapsed working days that count toward the rate
      const startStr = startByIntern.get(intern.id);

      for (let d = 1; d <= endDate.getUTCDate(); d++) {
        const dateStr = this.ds(y, m, d);
        const k = `${intern.id}|${dateStr}`;
        const status = manualMap.get(k) ?? (logSet.has(k) ? "P" : undefined);
        if (status) {
          days[dateStr] = status;
          if (status === "P") counts.P++;
          else if (status === "A") counts.A++;
          else if (status === "L") counts.L++;
          if (LEAVE_STATUSES.has(status)) counts.leave++;
        }

        // --- Attendance-rate accounting (denominator = elapsed working days) ---
        if (dateStr > todayStr) continue; // future day — ignore entirely
        if (!startStr || dateStr < startStr) continue; // before this intern started
        const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
        const isWorkingDay = dow !== 6 || rosterSet.has(k);
        if (!isWorkingDay) continue; // weekly holiday, not rostered
        if (status === "ND") continue; // explicitly no duty
        if (status === "AL" || status === "CL") continue; // approved leave: excused

        expected++;
        if (status === "P" || status === "L") present += 1;
        else if (status === "HD") present += 0.5;
        // "A", "UL", or no record at all → an absent working day (present += 0).
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
        attendanceRate: expected > 0 ? Math.round((present / expected) * 100) : 0,
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

    const rosters = await this.prisma.saturdayRoster.findMany({
      where: { internId: id, date: { gte: startDate, lte: endDate } },
      select: { date: true },
    });
    const rosterDates = new Set(rosters.map((r) => r.date.toISOString().split("T")[0]));

    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(r.date.toISOString().split("T")[0], r.status);
    const logSet = new Set(callLogs.map((l) => l.date.toISOString().split("T")[0]));

    const breakdown: Record<string, number> = {};
    const absencesByWeekday = new Map<number, number>();
    let leaveCount = 0;
    let unapprovedCount = 0;
    let presentCredit = 0;
    let expectedDays = 0;
    let consecutiveAbsent = 0;
    let maxConsecutiveAbsent = 0;
    let friMonAbsences = 0;
    let totalAbsent = 0;

    const todayStr = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString().split("T")[0];

    for (let d = 1; d <= endDate.getUTCDate(); d++) {
      const dateStr = this.ds(y, m, d);
      const status = manualMap.get(dateStr) ?? (logSet.has(dateStr) ? "P" : undefined);

      if (status) {
        breakdown[status] = (breakdown[status] || 0) + 1;
        if (LEAVE_STATUSES.has(status)) leaveCount++;
        if (status === "UL") unapprovedCount++;
        if (ABSENT_STATUSES.has(status)) {
          const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
          absencesByWeekday.set(wd, (absencesByWeekday.get(wd) || 0) + 1);
          if (wd === 5 || wd === 1) friMonAbsences++;
        }
      }

      // Attendance rate calculation (same logic as getGrid)
      if (dateStr > todayStr) continue;
      const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      const isWorkingDay = dow !== 6 || rosterDates.has(dateStr);
      if (!isWorkingDay) continue;
      if (status === "ND") continue;
      if (status === "AL" || status === "CL") continue;

      expectedDays++;
      if (status === "P" || status === "L") {
        presentCredit += 1;
        consecutiveAbsent = 0;
      } else if (status === "HD") {
        presentCredit += 0.5;
        consecutiveAbsent = 0;
      } else {
        // Absent or no record
        totalAbsent++;
        consecutiveAbsent++;
        maxConsecutiveAbsent = Math.max(maxConsecutiveAbsent, consecutiveAbsent);
      }
    }

    const attendanceRate = expectedDays > 0 ? Math.round((presentCredit / expectedDays) * 100) : 0;
    const cl = comp.get(id) ?? { earned: 0, used: 0, balance: 0, earningSaturdays: [] };

    const kpiRow = await this.prisma.kpiTarget.findFirst();
    const minAttendanceRate = kpiRow?.minAttendanceRate ?? 85;
    const criticalThreshold = Math.max(minAttendanceRate - 35, 20);

    // Comprehensive flag detection
    const flags: string[] = [];

    if (expectedDays > 0 && attendanceRate < criticalThreshold) {
      flags.push(`Critical: Only ${attendanceRate}% attendance (${Math.round(presentCredit)}/${expectedDays} days) — target: ${minAttendanceRate}%`);
    } else if (expectedDays > 0 && attendanceRate < minAttendanceRate) {
      flags.push(`Low attendance: ${attendanceRate}% (${Math.round(presentCredit)}/${expectedDays} days) — target: ${minAttendanceRate}%`);
    }

    if (maxConsecutiveAbsent >= 3) {
      flags.push(`${maxConsecutiveAbsent} consecutive absent days (possible abandonment)`);
    } else if (maxConsecutiveAbsent >= 2) {
      flags.push(`${maxConsecutiveAbsent} consecutive absent days`);
    }

    if (totalAbsent > 0 && expectedDays > 0 && totalAbsent >= expectedDays * 0.5) {
      flags.push(`Absent more than half the working days (${totalAbsent}/${expectedDays})`);
    }

    if (friMonAbsences >= 2) {
      flags.push(`Friday/Monday absence pattern detected (${friMonAbsences}×) — possible weekend extension`);
    }

    for (const [wd, c] of absencesByWeekday) {
      if (c >= 2) flags.push(`Repeated absence on ${WEEKDAYS[wd]} (${c}×)`);
    }

    if (leaveCount >= 3) flags.push(`${leaveCount} leaves this month`);
    if (unapprovedCount > 1) flags.push(`${unapprovedCount} unapproved leaves this month`);
    if (cl.used > cl.earned) flags.push(`Comp leave overspent (used ${cl.used} / earned ${cl.earned})`);

    if (expectedDays >= 5 && presentCredit === 0) {
      flags.push(`No attendance recorded for ${expectedDays} working days — inactive/ghost intern`);
    }

    return {
      intern: { id: intern.id, internId: intern.internId, name: intern.name, team: intern.team },
      month: m + 1,
      year: y,
      breakdown,
      attendanceRate,
      expectedDays,
      presentDays: Math.round(presentCredit),
      absentDays: totalAbsent,
      maxConsecutiveAbsent,
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

  // ---------------------------------------------------------------------------
  // Bulk mark — saves a whole batch of edits (any interns, any days) in one
  // request. An empty status clears the manual record for that day. All rows go
  // through a single transaction so the grid never half-saves.
  // ---------------------------------------------------------------------------
  @Post("bulk")
  async markBulk(
    @Body()
    body: {
      records: { internId: string; date: string; status: string; notes?: string }[];
    },
  ) {
    const records = body?.records ?? [];
    if (records.length === 0) return { saved: 0, cleared: 0, warnings: [] };

    const upserts = records.filter((r) => r.status);
    const clears = records.filter((r) => !r.status);

    // CL edits that would overdraw the comp-leave balance still save, but warn —
    // same rule as the single-mark endpoint.
    const warnings: string[] = [];
    const clInternIds = [...new Set(upserts.filter((r) => r.status === "CL").map((r) => r.internId))];
    if (clInternIds.length > 0) {
      const [comp, interns] = await Promise.all([
        this.computeCompLeave(clInternIds),
        this.prisma.intern.findMany({
          where: { id: { in: clInternIds } },
          select: { id: true, name: true },
        }),
      ]);
      const nameById = new Map(interns.map((i) => [i.id, i.name]));
      for (const internId of clInternIds) {
        const newCls = upserts.filter((r) => r.internId === internId && r.status === "CL").length;
        const balance = comp.get(internId)?.balance ?? 0;
        if (balance < newCls) {
          warnings.push(
            `${nameById.get(internId) ?? internId}: CL exceeds earned comp-leave balance (${balance}).`,
          );
        }
      }
    }

    await this.prisma.$transaction([
      ...upserts.map((r) => {
        const date = new Date(`${r.date}T00:00:00Z`);
        return this.prisma.attendance.upsert({
          where: { internId_date: { internId: r.internId, date } },
          update: { status: r.status as any, notes: r.notes },
          create: { internId: r.internId, date, status: r.status as any, notes: r.notes },
        });
      }),
      ...clears.map((r) =>
        this.prisma.attendance.deleteMany({
          where: { internId: r.internId, date: new Date(`${r.date}T00:00:00Z`) },
        }),
      ),
    ]);

    return { saved: upserts.length, cleared: clears.length, warnings };
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

  // Comp-leave engine lives in ./comp-leave.util (shared with InternsController).
  private computeCompLeave(internIds?: string[]): Promise<Map<string, CompLeave>> {
    return computeCompLeave(this.prisma, internIds);
  }

  // date helpers -- everything keyed on the UTC calendar day (yyyy-mm-dd)
  private key(internId: string, date: Date): string {
    return `${internId}|${date.toISOString().split("T")[0]}`;
  }

  private ds(y: number, m: number, d: number): string {
    return new Date(Date.UTC(y, m, d)).toISOString().split("T")[0];
  }
}
