import { Controller, Get, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  adToBS,
  bsToAD,
  formatNepaliDate,
  BS_MONTHS,
  getNepaliMonthRange,
  getDaysInBsMonth,
  getCurrentNepaliDate,
  ATTENDANCE_START_AD,
  NepaliDate,
} from "../utils/nepali-date";
import { computeCompLeave, EMPTY_COMP_LEAVE } from "../attendance/comp-leave.util";

@Controller("api/performance")
export class PerformanceController {
  constructor(private prisma: PrismaService) {}

  // Weekly performance for a given Nepali month, grouped by Nepali week (Sun–Sat)
  @Get("weekly")
  async getWeeklyPerformance(
    @Query("bsYear") bsYearStr?: string,
    @Query("bsMonth") bsMonthStr?: string,
    @Query("team") team?: string,
  ) {
    const now = getCurrentNepaliDate();
    const bsYear = bsYearStr ? parseInt(bsYearStr) : now.year;
    const bsMonth = bsMonthStr ? parseInt(bsMonthStr) : now.month;

    const { start, end } = getNepaliMonthRange(bsYear, bsMonth);

    const where: any = { active: true };
    if (team && ["ALPHA", "CALL_CENTER", "EA"].includes(team)) {
      where.team = team;
    }

    const [interns, callLogs, attendance, rosters] = await Promise.all([
      this.prisma.intern.findMany({ where, orderBy: { internId: "asc" } }),
      this.prisma.callLog.findMany({
        where: { date: { gte: start, lte: end } },
        include: { intern: { select: { name: true, team: true } } },
      }),
      this.prisma.attendance.findMany({
        where: { date: { gte: start, lte: end } },
      }),
      this.prisma.saturdayRoster.findMany({
        where: { date: { gte: start, lte: end } },
      }),
    ]);

    // Build weeks within the Nepali month
    const daysInMonth = getDaysInBsMonth(bsYear, bsMonth);
    const weeks: Array<{
      weekNum: number;
      label: string;
      startDay: number;
      endDay: number;
      adStart: string;
      adEnd: string;
    }> = [];

    let weekNum = 1;
    let dayPtr = 1;
    while (dayPtr <= daysInMonth) {
      const adDay = bsToAD({ year: bsYear, month: bsMonth, day: dayPtr });
      const dow = adDay.getUTCDay(); // 0=Sun
      const daysUntilSat = 6 - dow;
      const weekEndDay = Math.min(dayPtr + daysUntilSat, daysInMonth);
      const adEnd = bsToAD({ year: bsYear, month: bsMonth, day: weekEndDay });

      weeks.push({
        weekNum,
        label: `Week ${weekNum} (${dayPtr}–${weekEndDay} ${BS_MONTHS[bsMonth - 1]})`,
        startDay: dayPtr,
        endDay: weekEndDay,
        adStart: adDay.toISOString().split("T")[0],
        adEnd: adEnd.toISOString().split("T")[0],
      });

      dayPtr = weekEndDay + 1;
      weekNum++;
    }

    // Group call logs by intern and week
    const internIds = new Set(interns.map((i) => i.id));
    const rosterSet = new Set(rosters.map((r) => `${r.internId}|${r.date.toISOString().split("T")[0]}`));

    const weeklyData = weeks.map((week) => {
      const weekCallLogs = callLogs.filter((l) => {
        const d = l.date.toISOString().split("T")[0];
        return d >= week.adStart && d <= week.adEnd;
      });

      const weekAttendance = attendance.filter((a) => {
        const d = a.date.toISOString().split("T")[0];
        return d >= week.adStart && d <= week.adEnd && a.date >= ATTENDANCE_START_AD;
      });

      // Per-intern weekly stats
      const internStats = new Map<string, {
        callsMade: number;
        callsReceived: number;
        interested: number;
        tours: number;
        hours: number;
        daysWorked: number;
        present: number;
        absent: number;
        late: number;
        expectedDays: number;
      }>();

      for (const intern of interns) {
        internStats.set(intern.id, {
          callsMade: 0, callsReceived: 0, interested: 0, tours: 0,
          hours: 0, daysWorked: 0, present: 0, absent: 0, late: 0, expectedDays: 0,
        });
      }

      for (const log of weekCallLogs) {
        if (!internIds.has(log.internId)) continue;
        const stat = internStats.get(log.internId)!;
        stat.callsMade += log.callsMade;
        stat.callsReceived += log.callsReceived;
        stat.interested += log.interestedVisit;
        stat.tours += log.toursMade;
        stat.hours += log.hoursWorked;
        stat.daysWorked++;
      }

      // Only count attendance from ASADH 1 (June 15) forward
      if (new Date(week.adEnd) >= ATTENDANCE_START_AD) {
        const attByIntern = new Map<string, Map<string, string>>();
        for (const a of weekAttendance) {
          if (!internIds.has(a.internId)) continue;
          if (!attByIntern.has(a.internId)) attByIntern.set(a.internId, new Map());
          attByIntern.get(a.internId)!.set(a.date.toISOString().split("T")[0], a.status);
        }

        // Also count call logs as present for attendance if no manual record
        for (const log of weekCallLogs) {
          if (!internIds.has(log.internId)) continue;
          if (!attByIntern.has(log.internId)) attByIntern.set(log.internId, new Map());
          const dateStr = log.date.toISOString().split("T")[0];
          if (new Date(dateStr) >= ATTENDANCE_START_AD && !attByIntern.get(log.internId)!.has(dateStr)) {
            attByIntern.get(log.internId)!.set(dateStr, "P");
          }
        }

        for (const intern of interns) {
          const stat = internStats.get(intern.id)!;
          const attMap = attByIntern.get(intern.id) ?? new Map();

          // Count expected working days in this week (from attendance start)
          const effStart = week.adStart >= ATTENDANCE_START_AD.toISOString().split("T")[0]
            ? week.adStart
            : ATTENDANCE_START_AD.toISOString().split("T")[0];
          const effEnd = week.adEnd > new Date().toISOString().split("T")[0]
            ? new Date().toISOString().split("T")[0]
            : week.adEnd;

          for (let d = new Date(effStart); d.toISOString().split("T")[0] <= effEnd; d = new Date(d.getTime() + 86400000)) {
            const dateStr = d.toISOString().split("T")[0];
            const dow = d.getUTCDay();
            const rKey = `${intern.id}|${dateStr}`;
            if (dow === 6 && !rosterSet.has(rKey)) continue;
            const status = attMap.get(dateStr);
            if (status === "ND" || status === "AL" || status === "CL") continue;
            stat.expectedDays++;
            if (status === "P") stat.present++;
            else if (status === "L") { stat.present++; stat.late++; }
            else if (status === "HD") stat.present += 0.5;
            else stat.absent++;
          }
        }
      }

      // Aggregate totals for this week
      let totalCalls = 0, totalReceived = 0, totalInterested = 0, totalTours = 0, totalHours = 0;
      let totalPresent = 0, totalExpected = 0;
      const internRows: any[] = [];

      for (const intern of interns) {
        const stat = internStats.get(intern.id)!;
        totalCalls += stat.callsMade;
        totalReceived += stat.callsReceived;
        totalInterested += stat.interested;
        totalTours += stat.tours;
        totalHours += stat.hours;
        totalPresent += stat.present;
        totalExpected += stat.expectedDays;

        if (stat.daysWorked > 0 || stat.expectedDays > 0) {
          internRows.push({
            id: intern.id,
            internId: intern.internId,
            name: intern.name,
            team: intern.team,
            ...stat,
            avgCallsPerDay: stat.daysWorked > 0 ? Math.round(stat.callsMade / stat.daysWorked) : 0,
            attendanceRate: stat.expectedDays > 0 ? Math.round((stat.present / stat.expectedDays) * 100) : null,
          });
        }
      }

      return {
        ...week,
        bsMonth: BS_MONTHS[bsMonth - 1],
        bsYear,
        totals: {
          calls: totalCalls,
          received: totalReceived,
          interested: totalInterested,
          tours: totalTours,
          hours: Math.round(totalHours),
          attendanceRate: totalExpected > 0 ? Math.round((totalPresent / totalExpected) * 100) : null,
        },
        interns: internRows.sort((a, b) => b.callsMade - a.callsMade),
      };
    });

    return {
      bsYear,
      bsMonth,
      bsMonthName: BS_MONTHS[bsMonth - 1],
      weeks: weeklyData,
    };
  }

  // Monthly performance grouped by Nepali months
  @Get("monthly")
  async getMonthlyPerformance(
    @Query("bsYear") bsYearStr?: string,
    @Query("team") team?: string,
  ) {
    const now = getCurrentNepaliDate();
    const bsYear = bsYearStr ? parseInt(bsYearStr) : now.year;

    const where: any = { active: true };
    if (team && ["ALPHA", "CALL_CENTER", "EA"].includes(team)) {
      where.team = team;
    }

    // Get AD range for the entire BS year
    const yearStart = bsToAD({ year: bsYear, month: 1, day: 1 });
    const yearEnd = bsToAD({ year: bsYear, month: 12, day: getDaysInBsMonth(bsYear, 12) });

    const [interns, callLogs, attendance, rosters] = await Promise.all([
      this.prisma.intern.findMany({ where, orderBy: { internId: "asc" } }),
      this.prisma.callLog.findMany({
        where: { date: { gte: yearStart, lte: yearEnd } },
      }),
      this.prisma.attendance.findMany({
        where: { date: { gte: yearStart, lte: yearEnd } },
      }),
      this.prisma.saturdayRoster.findMany({
        where: { date: { gte: yearStart, lte: yearEnd } },
      }),
    ]);

    const internIds = new Set(interns.map((i) => i.id));
    const rosterSet = new Set(rosters.map((r) => `${r.internId}|${r.date.toISOString().split("T")[0]}`));
    const todayStr = new Date().toISOString().split("T")[0];
    const attStartStr = ATTENDANCE_START_AD.toISOString().split("T")[0];

    const months: any[] = [];
    for (let m = 1; m <= 12; m++) {
      const { start, end } = getNepaliMonthRange(bsYear, m);
      const adStart = start.toISOString().split("T")[0];
      const adEnd = end.toISOString().split("T")[0];

      // Skip future months
      if (adStart > todayStr) break;

      const monthCallLogs = callLogs.filter((l) => {
        const d = l.date.toISOString().split("T")[0];
        return d >= adStart && d <= adEnd;
      });

      const monthAttendance = attendance.filter((a) => {
        const d = a.date.toISOString().split("T")[0];
        return d >= adStart && d <= adEnd;
      });

      // Aggregate per-intern
      const internStats = new Map<string, {
        callsMade: number;
        callsReceived: number;
        interested: number;
        tours: number;
        hours: number;
        daysWorked: number;
        present: number;
        expectedDays: number;
      }>();

      for (const intern of interns) {
        internStats.set(intern.id, {
          callsMade: 0, callsReceived: 0, interested: 0, tours: 0,
          hours: 0, daysWorked: 0, present: 0, expectedDays: 0,
        });
      }

      for (const log of monthCallLogs) {
        if (!internIds.has(log.internId)) continue;
        const stat = internStats.get(log.internId)!;
        stat.callsMade += log.callsMade;
        stat.callsReceived += log.callsReceived;
        stat.interested += log.interestedVisit;
        stat.tours += log.toursMade;
        stat.hours += log.hoursWorked;
        stat.daysWorked++;
      }

      // Attendance only from Asadh 1 forward
      const attendanceApplies = adEnd >= attStartStr;
      if (attendanceApplies) {
        const attByIntern = new Map<string, Map<string, string>>();
        for (const a of monthAttendance) {
          if (!internIds.has(a.internId)) continue;
          if (a.date.toISOString().split("T")[0] < attStartStr) continue;
          if (!attByIntern.has(a.internId)) attByIntern.set(a.internId, new Map());
          attByIntern.get(a.internId)!.set(a.date.toISOString().split("T")[0], a.status);
        }

        for (const log of monthCallLogs) {
          if (!internIds.has(log.internId)) continue;
          const dateStr = log.date.toISOString().split("T")[0];
          if (dateStr < attStartStr) continue;
          if (!attByIntern.has(log.internId)) attByIntern.set(log.internId, new Map());
          if (!attByIntern.get(log.internId)!.has(dateStr)) {
            attByIntern.get(log.internId)!.set(dateStr, "P");
          }
        }

        for (const intern of interns) {
          const stat = internStats.get(intern.id)!;
          const attMap = attByIntern.get(intern.id) ?? new Map();

          const effStart = adStart >= attStartStr ? adStart : attStartStr;
          const effEnd = adEnd > todayStr ? todayStr : adEnd;

          for (let d = new Date(effStart); d.toISOString().split("T")[0] <= effEnd; d = new Date(d.getTime() + 86400000)) {
            const dateStr = d.toISOString().split("T")[0];
            const dow = d.getUTCDay();
            const rKey = `${intern.id}|${dateStr}`;
            if (dow === 6 && !rosterSet.has(rKey)) continue;
            const status = attMap.get(dateStr);
            if (status === "ND" || status === "AL" || status === "CL") continue;
            stat.expectedDays++;
            if (status === "P" || status === "L") stat.present++;
            else if (status === "HD") stat.present += 0.5;
          }
        }
      }

      // Totals
      let totalCalls = 0, totalReceived = 0, totalInterested = 0, totalTours = 0;
      let totalHours = 0, totalPresent = 0, totalExpected = 0;
      const internRows: any[] = [];

      for (const intern of interns) {
        const stat = internStats.get(intern.id)!;
        totalCalls += stat.callsMade;
        totalReceived += stat.callsReceived;
        totalInterested += stat.interested;
        totalTours += stat.tours;
        totalHours += stat.hours;
        totalPresent += stat.present;
        totalExpected += stat.expectedDays;

        if (stat.daysWorked > 0 || stat.expectedDays > 0) {
          internRows.push({
            id: intern.id,
            internId: intern.internId,
            name: intern.name,
            team: intern.team,
            ...stat,
            avgCallsPerDay: stat.daysWorked > 0 ? Math.round(stat.callsMade / stat.daysWorked) : 0,
            attendanceRate: stat.expectedDays > 0 ? Math.round((stat.present / stat.expectedDays) * 100) : null,
          });
        }
      }

      months.push({
        bsMonth: m,
        bsMonthName: BS_MONTHS[m - 1],
        bsYear,
        adStart,
        adEnd,
        totals: {
          calls: totalCalls,
          received: totalReceived,
          interested: totalInterested,
          tours: totalTours,
          hours: Math.round(totalHours),
          attendanceRate: totalExpected > 0 ? Math.round((totalPresent / totalExpected) * 100) : null,
        },
        interns: internRows.sort((a, b) => b.callsMade - a.callsMade),
      });
    }

    return {
      bsYear,
      currentMonth: now.month,
      months,
    };
  }
}
