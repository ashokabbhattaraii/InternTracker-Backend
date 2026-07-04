import { Controller, Get, Post, Put, Delete, Body, Param, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { computeCompLeave, CompLeave, EMPTY_COMP_LEAVE } from "../attendance/comp-leave.util";
import { adToBS, formatNepaliDate, BS_MONTHS, getCurrentNepaliDate, ATTENDANCE_START_AD } from "../utils/nepali-date";

const LEAVE_STATUSES = new Set(["AL", "HD", "CL", "UL"]);
const ABSENT_STATUSES = new Set(["A", "UL"]);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type KpiTargets = {
  minCallsPerDay: number;
  minAttendanceRate: number;
};

const DEFAULT_TARGETS: KpiTargets = { minCallsPerDay: 15, minAttendanceRate: 85 };

@Controller("api/interns")
export class InternsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(@Query("active") active?: string, @Query("team") team?: string) {
    const where: any = active === "false" ? {} : { active: true };
    if (team && ["ALPHA", "CALL_CENTER", "EA"].includes(team)) {
      where.team = team;
    }
    return this.prisma.intern.findMany({
      where,
      orderBy: { internId: "asc" },
    });
  }

  // ---------------------------------------------------------------------------
  // RAG status board — classifies every active intern into RED (take action),
  // YELLOW (keep an eye on) or GREEN (going well) from the month's KPIs:
  // attendance rate, avg calls/day vs target, leave frequency, comp-leave debt.
  // NOTE: must be declared before ":id" so /status isn't captured as an id.
  // ---------------------------------------------------------------------------
  @Get("status")
  async getStatus(@Query("month") month?: string, @Query("year") year?: string) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    const startDate = new Date(Date.UTC(y, m, 1));
    const endDate = new Date(Date.UTC(y, m + 1, 0));

    const [interns, targets, manual, callLogs, rosters, comp, callFirst, attFirst] =
      await Promise.all([
        this.prisma.intern.findMany({ where: { active: true }, orderBy: { internId: "asc" } }),
        this.kpiTargets(),
        this.prisma.attendance.findMany({
          where: { date: { gte: startDate, lte: endDate } },
          select: { internId: true, date: true, status: true },
        }),
        this.prisma.callLog.findMany({
          where: { date: { gte: startDate, lte: endDate } },
          select: { internId: true, date: true, callsMade: true },
        }),
        this.prisma.saturdayRoster.findMany({
          where: { date: { gte: startDate, lte: endDate } },
          select: { internId: true, date: true },
        }),
        computeCompLeave(this.prisma),
        this.prisma.callLog.groupBy({ by: ["internId"], _min: { date: true } }),
        this.prisma.attendance.groupBy({ by: ["internId"], _min: { date: true } }),
      ]);

    const dkey = (internId: string, d: Date) => `${internId}|${d.toISOString().split("T")[0]}`;
    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(dkey(r.internId, r.date), r.status);
    const logSet = new Set<string>();
    const monthCallsBy = new Map<string, number>();
    const logDaysBy = new Map<string, Set<string>>();
    for (const l of callLogs) {
      const k = dkey(l.internId, l.date);
      logSet.add(k);
      monthCallsBy.set(l.internId, (monthCallsBy.get(l.internId) || 0) + l.callsMade);
      const days = logDaysBy.get(l.internId) ?? new Set<string>();
      days.add(k);
      logDaysBy.set(l.internId, days);
    }
    const rosterSet = new Set<string>();
    for (const r of rosters) rosterSet.add(dkey(r.internId, r.date));

    // First day each intern counts toward the rate (same rule as the grid).
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

    const todayStr = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
      .toISOString()
      .split("T")[0];

    const rows = interns.map((intern) => {
      let present = 0;
      let expected = 0;
      let leaveCount = 0;
      let unapprovedLeaves = 0;
      const absencesByWeekday = new Map<number, number>();
      const startStr = startByIntern.get(intern.id);

      for (let d = 1; d <= endDate.getUTCDate(); d++) {
        const dateStr = new Date(Date.UTC(y, m, d)).toISOString().split("T")[0];
        const k = `${intern.id}|${dateStr}`;
        const status = manualMap.get(k) ?? (logSet.has(k) ? "P" : undefined);
        if (status && LEAVE_STATUSES.has(status)) leaveCount++;
        if (status === "UL") unapprovedLeaves++;
        if (status && ABSENT_STATUSES.has(status)) {
          const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
          absencesByWeekday.set(wd, (absencesByWeekday.get(wd) || 0) + 1);
        }

        if (dateStr > todayStr) continue;
        if (!startStr || dateStr < startStr) continue;
        const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
        if (dow === 6 && !rosterSet.has(k)) continue; // weekly holiday, not rostered
        if (status === "ND") continue;
        if (status === "AL" || status === "CL") continue; // approved leave: excused
        expected++;
        if (status === "P" || status === "L") present += 1;
        else if (status === "HD") present += 0.5;
      }

      const attendanceRate = expected > 0 ? Math.round((present / expected) * 100) : 0;
      const monthCalls = monthCallsBy.get(intern.id) || 0;
      const daysWorked = logDaysBy.get(intern.id)?.size || 0;
      const avgCallsPerDay = daysWorked > 0 ? Math.round(monthCalls / daysWorked) : 0;
      const cl = comp.get(intern.id) ?? EMPTY_COMP_LEAVE;

      const flags: string[] = [];
      for (const [wd, c] of absencesByWeekday) {
        if (c >= 2) flags.push(`Repeated absence on ${WEEKDAYS[wd]} (${c}×)`);
      }

      const { category, reasons } = this.categorize({
        attendanceRate,
        avgCallsPerDay,
        daysWorked,
        expected,
        unapprovedLeaves,
        leaveCount,
        cl,
        targets,
      });

      return {
        id: intern.id,
        internId: intern.internId,
        name: intern.name,
        team: intern.team,
        category,
        reasons,
        flags,
        attendanceRate,
        monthCalls,
        avgCallsPerDay,
        daysWorked,
        leaveCount,
        unapprovedLeaves,
        clEarned: cl.earned,
        clUsed: cl.used,
        clBalance: cl.balance,
      };
    });

    const summary = {
      red: rows.filter((r) => r.category === "RED").length,
      yellow: rows.filter((r) => r.category === "YELLOW").length,
      green: rows.filter((r) => r.category === "GREEN").length,
    };

    return { month: m + 1, year: y, targets, summary, interns: rows };
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    return this.prisma.intern.findUnique({
      where: { id },
      include: {
        attendance: { orderBy: { date: "desc" }, take: 31 },
        callLogs: { orderBy: { date: "desc" }, take: 30 },
        tourLogs: { orderBy: { date: "desc" }, take: 30 },
        leaveRequests: { orderBy: { appliedOn: "desc" }, take: 10 },
      },
    });
  }

  @Get(":id/performance")
  async getPerformance(@Param("id") id: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // The DB is remote (~150ms RTT) — fire every independent query in one
    // parallel batch instead of paying the round trip 10× sequentially.
    const [
      intern,
      allCallLogs,
      allAttendance,
      tourLogs,
      leaveRequests,
      roster,
      compMap,
      targets,
      allInternMonthLogs,
    ] = await Promise.all([
      this.prisma.intern.findUnique({ where: { id } }),
      this.prisma.callLog.findMany({
        where: { internId: id },
        orderBy: { date: "asc" },
      }),
      this.prisma.attendance.findMany({
        where: { internId: id },
        orderBy: { date: "asc" },
      }),
      this.prisma.tourLog.findMany({
        where: { internId: id },
        orderBy: { date: "desc" },
      }),
      this.prisma.leaveRequest.findMany({
        where: { internId: id },
        orderBy: { appliedOn: "desc" },
      }),
      this.prisma.saturdayRoster.findMany({
        where: { internId: id },
        select: { date: true },
      }),
      computeCompLeave(this.prisma, [id]),
      this.kpiTargets(),
      // Rank among all interns this month (by calls made).
      this.prisma.callLog.groupBy({
        by: ["internId"],
        where: { date: { gte: monthStart, lte: monthEnd } },
        _sum: { callsMade: true },
        orderBy: { _sum: { callsMade: "desc" } },
      }),
    ]);
    if (!intern) return null;

    const monthCallLogs = allCallLogs.filter(
      (l) => l.date >= monthStart && l.date <= monthEnd,
    );

    // Call performance metrics
    const totalCalls = allCallLogs.reduce((s, l) => s + l.callsMade, 0);
    const totalReceived = allCallLogs.reduce((s, l) => s + l.callsReceived, 0);
    const totalInterested = allCallLogs.reduce((s, l) => s + l.interestedVisit, 0);
    const totalTours = allCallLogs.reduce((s, l) => s + l.toursMade, 0);
    const totalHours = allCallLogs.reduce((s, l) => s + l.hoursWorked, 0);
    const totalDaysWorked = allCallLogs.length;

    const monthCalls = monthCallLogs.reduce((s, l) => s + l.callsMade, 0);
    const monthReceived = monthCallLogs.reduce((s, l) => s + l.callsReceived, 0);
    const monthInterested = monthCallLogs.reduce((s, l) => s + l.interestedVisit, 0);
    const monthToursMade = monthCallLogs.reduce((s, l) => s + l.toursMade, 0);
    const monthHours = monthCallLogs.reduce((s, l) => s + l.hoursWorked, 0);

    const avgCallsPerDay = totalDaysWorked > 0 ? Math.round(totalCalls / totalDaysWorked) : 0;
    const avgHoursPerDay = totalDaysWorked > 0 ? Math.round((totalHours / totalDaysWorked) * 10) / 10 : 0;
    const connectionRate = totalCalls > 0 ? Math.round((totalReceived / totalCalls) * 100) : 0;
    const conversionRate = totalCalls > 0 ? Math.round((totalInterested / totalCalls) * 100) : 0;

    // Attendance metrics — consistent with the monthly grid: a call-log
    // submission derives a "P", a manual status overrides it, and the rate is
    // measured over elapsed working days (Sun–Fri + rostered Saturdays) so days
    // with no submission count as absent instead of inflating the rate to 100%.
    const effective = new Map<string, string>();
    for (const l of allCallLogs) effective.set(l.date.toISOString().split("T")[0], "P");
    for (const a of allAttendance) effective.set(a.date.toISOString().split("T")[0], a.status);

    const rosterSet = new Set(roster.map((r) => r.date.toISOString().split("T")[0]));
    const cl = compMap.get(id) ?? EMPTY_COMP_LEAVE;

    const activity = [
      ...allCallLogs.map((l) => l.date),
      ...allAttendance.map((a) => a.date),
      ...(intern.joinDate ? [intern.joinDate] : []),
    ];

    let present = 0; // present-ish credit: P/L = 1, HD = 0.5
    let expected = 0; // elapsed working days
    let presentDays = 0;
    let absentDays = 0;
    let lateDays = 0;
    let halfDays = 0;
    // this-month counters (for the RAG category, consistent with /status)
    let monthPresent = 0;
    let monthExpected = 0;
    let monthLeaveCount = 0;
    let monthUnapproved = 0;
    const monthAbsencesByWeekday = new Map<number, number>();
    // lifetime leave breakdown
    const leaveDays: Record<string, number> = { AL: 0, CL: 0, UL: 0, HD: 0 };
    const monthStartStr = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
      .toISOString()
      .split("T")[0];

    if (activity.length > 0) {
      const first = new Date(Math.min(...activity.map((d) => d.getTime())));
      const startUTC = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
      const today = new Date();
      const endUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const DAY = 86400000;
      for (let t = startUTC; t <= endUTC; t += DAY) {
        const day = new Date(t);
        const dateStr = day.toISOString().split("T")[0];
        const status = effective.get(dateStr);
        const inMonth = dateStr >= monthStartStr;
        if (status === "P") presentDays++;
        else if (status === "A" || status === "UL") absentDays++;
        else if (status === "L") lateDays++;
        else if (status === "HD") halfDays++;
        if (status && status in leaveDays) leaveDays[status]++;
        if (inMonth && status) {
          if (status === "AL" || status === "CL" || status === "UL" || status === "HD")
            monthLeaveCount++;
          if (status === "UL") monthUnapproved++;
          if (status === "A" || status === "UL") {
            const wd = day.getUTCDay();
            monthAbsencesByWeekday.set(wd, (monthAbsencesByWeekday.get(wd) || 0) + 1);
          }
        }

        const dow = day.getUTCDay();
        const isWorkingDay = dow !== 6 || rosterSet.has(dateStr);
        if (!isWorkingDay) continue; // weekly holiday, not rostered
        if (status === "ND") continue; // no duty
        if (status === "AL" || status === "CL") continue; // approved leave: excused
        expected++;
        if (inMonth) monthExpected++;
        if (status === "P" || status === "L") {
          present += 1;
          if (inMonth) monthPresent += 1;
        } else if (status === "HD") {
          present += 0.5;
          if (inMonth) monthPresent += 0.5;
        }
        // "A", "UL", or no record → absent working day.
      }
    }

    const attendanceRate = expected > 0 ? Math.round((present / expected) * 100) : 0;
    const monthAttendanceRate =
      monthExpected > 0 ? Math.round((monthPresent / monthExpected) * 100) : 0;

    // Daily call trend (last 14 days of data) — includes Nepali date
    const dailyTrend = allCallLogs.slice(-14).map((l) => {
      const bs = adToBS(l.date);
      return {
        date: l.date.toISOString().split("T")[0],
        nepaliDate: formatNepaliDate(bs),
        nepaliDay: `${bs.day} ${BS_MONTHS[bs.month - 1]}`,
        callsMade: l.callsMade,
        callsReceived: l.callsReceived,
        interested: l.interestedVisit,
        tours: l.toursMade,
      };
    });

    // Weekly aggregation — grouped by Nepali week (Sun–Sat)
    const weeklyMap = new Map();
    allCallLogs.forEach((l) => {
      const weekStart = getWeekStart(l.date);
      const key = weekStart.toISOString().split("T")[0];
      const bs = adToBS(weekStart);
      const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
      const bsEnd = adToBS(weekEnd);
      const nepaliLabel = `${bs.day} ${BS_MONTHS[bs.month - 1]} – ${bsEnd.day} ${BS_MONTHS[bsEnd.month - 1]}`;
      const existing = weeklyMap.get(key) || { calls: 0, received: 0, interested: 0, tours: 0, days: 0, nepaliLabel };
      existing.calls += l.callsMade;
      existing.received += l.callsReceived;
      existing.interested += l.interestedVisit;
      existing.tours += l.toursMade;
      existing.days += 1;
      weeklyMap.set(key, existing);
    });
    const weeklyTrend = Array.from(weeklyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([week, data]) => ({ week, ...data }));

    // KPI assessment (target comes from the KpiTarget settings row)
    const kpiTarget = targets.minCallsPerDay;
    const daysAboveTarget = allCallLogs.filter((l) => l.callsMade >= kpiTarget).length;
    const kpiAchievement = totalDaysWorked > 0
      ? Math.round((daysAboveTarget / totalDaysWorked) * 100)
      : 0;

    const rank = allInternMonthLogs.findIndex((r) => r.internId === id) + 1;
    const totalActiveInterns = allInternMonthLogs.length;

    // Leave-pattern flags (this month) + RAG category, same rules as /status.
    const flags: string[] = [];
    for (const [wd, c] of monthAbsencesByWeekday) {
      if (c >= 2) flags.push(`Repeated absence on ${WEEKDAYS[wd]} (${c}×)`);
    }
    if (monthLeaveCount >= 3) flags.push(`${monthLeaveCount} leaves this month`);
    if (monthUnapproved > 1) flags.push(`Unapproved leave ${monthUnapproved}× this month`);
    if (cl.used > cl.earned)
      flags.push(`Comp leave overspent (used ${cl.used} / earned ${cl.earned})`);

    const monthDaysWorked = monthCallLogs.length;
    const monthAvgCalls = monthDaysWorked > 0 ? Math.round(monthCalls / monthDaysWorked) : 0;
    const { category, reasons } = this.categorize({
      attendanceRate: monthAttendanceRate,
      avgCallsPerDay: monthAvgCalls,
      daysWorked: monthDaysWorked,
      expected: monthExpected,
      unapprovedLeaves: monthUnapproved,
      leaveCount: monthLeaveCount,
      cl,
      targets,
    });

    const currentNepali = getCurrentNepaliDate();
    const nepaliMonth = `${BS_MONTHS[currentNepali.month - 1]} ${currentNepali.year}`;

    return {
      category,
      reasons,
      flags,
      nepaliDate: {
        today: formatNepaliDate(currentNepali),
        todayFull: `${currentNepali.day} ${BS_MONTHS[currentNepali.month - 1]} ${currentNepali.year}`,
        currentMonth: nepaliMonth,
        attendanceStartBS: "1 Asadh 2082",
        attendanceStartAD: ATTENDANCE_START_AD.toISOString().split("T")[0],
      },
      compLeave: {
        earned: cl.earned,
        used: cl.used,
        balance: cl.balance,
        earningSaturdays: cl.earningSaturdays,
      },
      saturday: {
        rostered: rosterSet.size,
        present: cl.earned,
        dates: cl.earningSaturdays,
      },
      leaveDays: {
        ...leaveDays,
        total: leaveDays.AL + leaveDays.CL + leaveDays.UL + leaveDays.HD,
        thisMonth: monthLeaveCount,
        unapprovedThisMonth: monthUnapproved,
      },
      intern,
      summary: {
        totalCalls,
        totalReceived,
        totalInterested,
        totalTours,
        totalHours: Math.round(totalHours),
        totalDaysWorked,
        avgCallsPerDay,
        avgHoursPerDay,
        connectionRate,
        conversionRate,
      },
      thisMonth: {
        calls: monthCalls,
        received: monthReceived,
        interested: monthInterested,
        tours: monthToursMade,
        hours: Math.round(monthHours),
        daysWorked: monthCallLogs.length,
        nepaliMonth,
      },
      attendance: {
        totalDays: expected,
        present: presentDays,
        absent: absentDays,
        late: lateDays,
        halfDays,
        rate: attendanceRate,
        monthRate: monthAttendanceRate,
      },
      ranking: { rank, total: totalActiveInterns },
      kpi: {
        target: kpiTarget,
        daysAboveTarget,
        achievement: kpiAchievement,
      },
      dailyTrend,
      weeklyTrend,
      recentCallLogs: allCallLogs.slice(-10).reverse(),
      tourLogs: tourLogs.slice(0, 10),
      leaveRequests: leaveRequests.slice(0, 10),
    };
  }

  @Post()
  async create(
    @Body()
    body: {
      internId: string;
      name: string;
      email?: string;
      phone?: string;
      role?: "INTERN" | "SUPERVISOR" | "ADMIN";
      shift?: string;
      joinDate?: string;
      supervisor?: string;
    },
  ) {
    return this.prisma.intern.create({
      data: {
        ...body,
        joinDate: body.joinDate ? new Date(body.joinDate) : undefined,
      },
    });
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      email?: string;
      phone?: string;
      role?: "INTERN" | "SUPERVISOR" | "ADMIN";
      shift?: string;
      supervisor?: string;
      active?: boolean;
    },
  ) {
    return this.prisma.intern.update({ where: { id }, data: body });
  }

  @Delete(":id")
  async deactivate(@Param("id") id: string) {
    return this.prisma.intern.update({
      where: { id },
      data: { active: false },
    });
  }

  // ---------------------------------------------------------------------------
  // RAG rules:
  //   RED    — any hard signal: attendance >15 pts under target, calls under 60%
  //            of target, 2+ unapproved leaves, or comp leave overspent.
  //   YELLOW — soft signals: attendance/calls below target, 1 unapproved leave,
  //            3+ leaves this month, or no data at all yet.
  //   GREEN  — everything on track.
  // ---------------------------------------------------------------------------
  private categorize(input: {
    attendanceRate: number;
    avgCallsPerDay: number;
    daysWorked: number;
    expected: number;
    unapprovedLeaves: number;
    leaveCount: number;
    cl: CompLeave;
    targets: KpiTargets;
  }): { category: "RED" | "YELLOW" | "GREEN"; reasons: string[] } {
    const { attendanceRate, avgCallsPerDay, daysWorked, expected, unapprovedLeaves, leaveCount, cl, targets } = input;

    if (expected === 0 && daysWorked === 0) {
      return { category: "YELLOW", reasons: ["No activity recorded this month yet"] };
    }

    const reasons: string[] = [];
    if (attendanceRate < targets.minAttendanceRate - 15)
      reasons.push(`Attendance ${attendanceRate}% — far below the ${targets.minAttendanceRate}% target`);
    if (daysWorked > 0 && avgCallsPerDay < targets.minCallsPerDay * 0.6)
      reasons.push(`Avg ${avgCallsPerDay} calls/day — under 60% of the ${targets.minCallsPerDay}/day target`);
    if (unapprovedLeaves >= 2) reasons.push(`${unapprovedLeaves} unapproved leaves this month`);
    if (cl.used > cl.earned)
      reasons.push(`Comp leave overspent (used ${cl.used} / earned ${cl.earned})`);
    if (reasons.length > 0) return { category: "RED", reasons };

    if (attendanceRate < targets.minAttendanceRate)
      reasons.push(`Attendance ${attendanceRate}% — below the ${targets.minAttendanceRate}% target`);
    if (daysWorked > 0 && avgCallsPerDay < targets.minCallsPerDay)
      reasons.push(`Avg ${avgCallsPerDay} calls/day — below the ${targets.minCallsPerDay}/day target`);
    if (unapprovedLeaves === 1) reasons.push("1 unapproved leave this month");
    if (leaveCount >= 3) reasons.push(`${leaveCount} leaves this month`);
    if (reasons.length > 0) return { category: "YELLOW", reasons };

    return { category: "GREEN", reasons: ["Meeting attendance and call targets"] };
  }

  private async kpiTargets(): Promise<KpiTargets> {
    const row = await this.prisma.kpiTarget.findFirst();
    return {
      minCallsPerDay: row?.minCallsPerDay ?? DEFAULT_TARGETS.minCallsPerDay,
      minAttendanceRate: row?.minAttendanceRate ?? DEFAULT_TARGETS.minAttendanceRate,
    };
  }
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}
