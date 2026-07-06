import { Controller, Get, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const LEAVE_STATUSES = new Set(["AL", "HD", "CL", "UL"]);

@Controller("api/dashboard")
export class DashboardController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async getOverview() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // The DB is remote (~150ms RTT) — run all 7 independent queries in one
    // parallel batch instead of paying the round trip sequentially.
    const [
      totalInterns,
      teamCounts,
      todayAttendance,
      todayCalls,
      pendingLeaves,
      allInterns,
      monthCallLogs,
    ] = await Promise.all([
      this.prisma.intern.count({ where: { active: true } }),
      this.prisma.intern.groupBy({
        by: ["team"],
        where: { active: true },
        _count: true,
      }),
      this.prisma.attendance.findMany({
        where: { date: today },
        include: { intern: { select: { name: true, internId: true, team: true } } },
      }),
      this.prisma.callLog.findMany({
        where: { date: today },
        include: { intern: { select: { name: true, internId: true, team: true } } },
      }),
      this.prisma.leaveRequest.findMany({
        where: { status: "PENDING" },
        include: { intern: { select: { id: true, internId: true, name: true } } },
        orderBy: { appliedOn: "desc" },
      }),
      this.prisma.intern.findMany({
        where: { active: true },
        select: { id: true, name: true, internId: true, team: true },
      }),
      this.prisma.callLog.findMany({
        where: { date: { gte: monthStart, lte: monthEnd } },
        include: { intern: { select: { id: true, internId: true, name: true, team: true } } },
      }),
    ]);

    const present = todayAttendance.filter(
      (a) => a.status === "P" || a.status === "CL" || a.status === "AL",
    ).length;
    const absent = todayAttendance.filter(
      (a) => a.status === "A" || a.status === "UL",
    ).length;
    const late = todayAttendance.filter((a) => a.status === "L").length;

    const totalCallsToday = todayCalls.reduce((s, l) => s + l.callsMade, 0);
    const totalToursToday = todayCalls.reduce((s, l) => s + l.toursMade, 0);

    const alphaCallsToday = todayCalls
      .filter((l) => l.intern.team === "ALPHA")
      .reduce((s, l) => s + l.callsMade, 0);
    const ccCallsToday = todayCalls
      .filter((l) => l.intern.team === "CALL_CENTER" || l.intern.team === "EA")
      .reduce((s, l) => s + l.callsMade, 0);

    const checkedInIds = new Set(todayAttendance.map((a) => a.internId));
    const notCheckedIn = allInterns.filter((i) => !checkedInIds.has(i.id));

    const leaderboard = new Map<string, { id: string; name: string; internId: string; team: string; totalCalls: number; totalTours: number; interested: number }>();
    monthCallLogs.forEach((log) => {
      const existing = leaderboard.get(log.internId) || {
        id: log.internId,
        name: log.intern.name,
        internId: log.intern.internId,
        team: log.intern.team,
        totalCalls: 0,
        totalTours: 0,
        interested: 0,
      };
      existing.totalCalls += log.callsMade;
      existing.totalTours += log.toursMade;
      existing.interested += log.interestedVisit;
      leaderboard.set(log.internId, existing);
    });

    const allLeaderboard = Array.from(leaderboard.values())
      .sort((a, b) => b.totalCalls - a.totalCalls);

    return {
      totalInterns,
      teams: {
        alpha: teamCounts.find((t) => t.team === "ALPHA")?._count || 0,
        callCenter: teamCounts.find((t) => t.team === "CALL_CENTER")?._count || 0,
        ea: teamCounts.find((t) => t.team === "EA")?._count || 0,
      },
      present,
      absent,
      late,
      totalCallsToday,
      totalToursToday,
      alphaCallsToday,
      ccCallsToday,
      pendingLeaves: pendingLeaves.length,
      pendingLeavesList: pendingLeaves,
      notCheckedIn: notCheckedIn.map((i) => ({ id: i.id, name: i.name, team: i.team })),
      leaderboard: allLeaderboard.slice(0, 10),
      alphaLeaderboard: allLeaderboard.filter((l) => l.team === "ALPHA").slice(0, 5),
      ccLeaderboard: allLeaderboard.filter((l) => l.team === "CALL_CENTER" || l.team === "EA").slice(0, 5),
      todayCalls: todayCalls.map((l) => ({
        id: l.internId,
        name: l.intern.name,
        team: l.intern.team,
        callsMade: l.callsMade,
        interested: l.interestedVisit,
        tours: l.toursMade,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Alerts — at-risk interns for the current month. Returns interns with
  // attendance below thresholds, consecutive absence streaks, etc.
  // ---------------------------------------------------------------------------
  @Get("alerts")
  async getAlerts(@Query("month") month?: string, @Query("year") year?: string) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    const startDate = new Date(Date.UTC(y, m, 1));
    const endDate = new Date(Date.UTC(y, m + 1, 0));

    const interns = await this.prisma.intern.findMany({
      where: { active: true },
      select: { id: true, internId: true, name: true, team: true, joinDate: true },
    });

    const [manual, callLogs, rosters, callFirst, attFirst] = await Promise.all([
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
      this.prisma.callLog.groupBy({ by: ["internId"], _min: { date: true } }),
      this.prisma.attendance.groupBy({ by: ["internId"], _min: { date: true } }),
    ]);

    const manualMap = new Map<string, string>();
    for (const r of manual) manualMap.set(`${r.internId}|${r.date.toISOString().split("T")[0]}`, r.status);
    const logSet = new Set<string>();
    for (const l of callLogs) logSet.add(`${l.internId}|${l.date.toISOString().split("T")[0]}`);
    const rosterSet = new Set<string>();
    for (const r of rosters) rosterSet.add(`${r.internId}|${r.date.toISOString().split("T")[0]}`);

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
    ).toISOString().split("T")[0];

    const ds = (d: number) => new Date(Date.UTC(y, m, d)).toISOString().split("T")[0];

    const alerts: Array<{
      id: string;
      internId: string;
      name: string;
      team: string;
      attendanceRate: number;
      expectedDays: number;
      presentDays: number;
      absentDays: number;
      maxConsecutiveAbsent: number;
      severity: "critical" | "warning" | "info";
      reasons: string[];
    }> = [];

    for (const intern of interns) {
      const startStr = startByIntern.get(intern.id);
      let presentCredit = 0;
      let expectedDays = 0;
      let consecutiveAbsent = 0;
      let maxConsecutiveAbsent = 0;
      let totalAbsent = 0;
      let friMonAbsences = 0;
      let unapprovedCount = 0;

      for (let d = 1; d <= endDate.getUTCDate(); d++) {
        const dateStr = ds(d);
        const k = `${intern.id}|${dateStr}`;
        const status = manualMap.get(k) ?? (logSet.has(k) ? "P" : undefined);

        if (status === "UL") unapprovedCount++;
        if (status === "A" || status === "UL") {
          const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
          if (wd === 5 || wd === 1) friMonAbsences++;
        }

        if (dateStr > todayStr) continue;
        if (!startStr || dateStr < startStr) continue;
        const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
        const isWorkingDay = dow !== 6 || rosterSet.has(k);
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
          totalAbsent++;
          consecutiveAbsent++;
          maxConsecutiveAbsent = Math.max(maxConsecutiveAbsent, consecutiveAbsent);
        }
      }

      const attendanceRate = expectedDays > 0 ? Math.round((presentCredit / expectedDays) * 100) : 0;
      const reasons: string[] = [];
      let severity: "critical" | "warning" | "info" | null = null;

      if (expectedDays >= 3 && attendanceRate < 50) {
        reasons.push(`Only ${attendanceRate}% attendance (${Math.round(presentCredit)}/${expectedDays} days)`);
        severity = "critical";
      } else if (expectedDays >= 3 && attendanceRate < 70) {
        reasons.push(`Low attendance: ${attendanceRate}% (${Math.round(presentCredit)}/${expectedDays} days)`);
        severity = severity ?? "warning";
      }

      if (maxConsecutiveAbsent >= 3) {
        reasons.push(`${maxConsecutiveAbsent} consecutive absent days`);
        severity = severity ?? "critical";
      } else if (maxConsecutiveAbsent >= 2) {
        reasons.push(`${maxConsecutiveAbsent} consecutive absent days`);
        severity = severity ?? "warning";
      }

      if (expectedDays >= 5 && presentCredit === 0) {
        reasons.push(`No attendance for ${expectedDays} working days — inactive`);
        severity = "critical";
      }

      if (friMonAbsences >= 2) {
        reasons.push(`Friday/Monday absence pattern (${friMonAbsences}×)`);
        severity = severity ?? "warning";
      }

      if (unapprovedCount >= 2) {
        reasons.push(`${unapprovedCount} unapproved leaves`);
        severity = severity ?? "info";
      }

      if (reasons.length > 0 && severity) {
        alerts.push({
          id: intern.id,
          internId: intern.internId,
          name: intern.name,
          team: intern.team,
          attendanceRate,
          expectedDays,
          presentDays: Math.round(presentCredit),
          absentDays: totalAbsent,
          maxConsecutiveAbsent,
          severity,
          reasons,
        });
      }
    }

    alerts.sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
      return a.attendanceRate - b.attendanceRate;
    });

    return {
      month: m + 1,
      year: y,
      totalAlerts: alerts.length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      alerts,
    };
  }
}
