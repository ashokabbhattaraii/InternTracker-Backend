import { Controller, Get, Post, Put, Delete, Body, Param, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

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
    const intern = await this.prisma.intern.findUnique({ where: { id } });
    if (!intern) return null;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const allCallLogs = await this.prisma.callLog.findMany({
      where: { internId: id },
      orderBy: { date: "asc" },
    });

    const monthCallLogs = allCallLogs.filter(
      (l) => l.date >= monthStart && l.date <= monthEnd,
    );

    const allAttendance = await this.prisma.attendance.findMany({
      where: { internId: id },
      orderBy: { date: "asc" },
    });

    const monthAttendance = allAttendance.filter(
      (a) => a.date >= monthStart && a.date <= monthEnd,
    );

    const tourLogs = await this.prisma.tourLog.findMany({
      where: { internId: id },
      orderBy: { date: "desc" },
    });

    const leaveRequests = await this.prisma.leaveRequest.findMany({
      where: { internId: id },
      orderBy: { appliedOn: "desc" },
    });

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

    // Attendance metrics
    const attendanceDays = allAttendance.filter((a) => a.status !== "ND");
    const presentDays = allAttendance.filter(
      (a) => a.status === "P" || a.status === "CL" || a.status === "AL",
    );
    const absentDays = allAttendance.filter(
      (a) => a.status === "A" || a.status === "UL",
    );
    const lateDays = allAttendance.filter((a) => a.status === "L");
    const attendanceRate = attendanceDays.length > 0
      ? Math.round((presentDays.length / attendanceDays.length) * 100)
      : 0;

    // Daily call trend (last 14 days of data)
    const dailyTrend = allCallLogs.slice(-14).map((l) => ({
      date: l.date.toISOString().split("T")[0],
      callsMade: l.callsMade,
      callsReceived: l.callsReceived,
      interested: l.interestedVisit,
      tours: l.toursMade,
    }));

    // Weekly aggregation
    const weeklyMap = new Map();
    allCallLogs.forEach((l) => {
      const weekStart = getWeekStart(l.date);
      const key = weekStart.toISOString().split("T")[0];
      const existing = weeklyMap.get(key) || { calls: 0, received: 0, interested: 0, tours: 0, days: 0 };
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

    // KPI assessment
    const kpiTarget = 15; // min calls per day
    const daysAboveTarget = allCallLogs.filter((l) => l.callsMade >= kpiTarget).length;
    const kpiAchievement = totalDaysWorked > 0
      ? Math.round((daysAboveTarget / totalDaysWorked) * 100)
      : 0;

    // Rank among all interns this month
    const allInternMonthLogs = await this.prisma.callLog.groupBy({
      by: ["internId"],
      where: { date: { gte: monthStart, lte: monthEnd } },
      _sum: { callsMade: true },
      orderBy: { _sum: { callsMade: "desc" } },
    });
    const rank = allInternMonthLogs.findIndex((r) => r.internId === id) + 1;
    const totalActiveInterns = allInternMonthLogs.length;

    return {
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
      },
      attendance: {
        totalDays: attendanceDays.length,
        present: presentDays.length,
        absent: absentDays.length,
        late: lateDays.length,
        rate: attendanceRate,
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
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}
