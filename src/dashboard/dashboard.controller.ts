import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/dashboard")
export class DashboardController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async getOverview() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const totalInterns = await this.prisma.intern.count({
      where: { active: true },
    });

    const teamCounts = await this.prisma.intern.groupBy({
      by: ["team"],
      where: { active: true },
      _count: true,
    });

    const todayAttendance = await this.prisma.attendance.findMany({
      where: { date: today },
      include: { intern: { select: { name: true, internId: true, team: true } } },
    });

    const present = todayAttendance.filter(
      (a) => a.status === "P" || a.status === "CL" || a.status === "AL",
    ).length;
    const absent = todayAttendance.filter(
      (a) => a.status === "A" || a.status === "UL",
    ).length;
    const late = todayAttendance.filter((a) => a.status === "L").length;

    const todayCalls = await this.prisma.callLog.findMany({
      where: { date: today },
      include: { intern: { select: { name: true, internId: true, team: true } } },
    });
    const totalCallsToday = todayCalls.reduce((s, l) => s + l.callsMade, 0);
    const totalToursToday = todayCalls.reduce((s, l) => s + l.toursMade, 0);

    const alphaCallsToday = todayCalls
      .filter((l) => l.intern.team === "ALPHA")
      .reduce((s, l) => s + l.callsMade, 0);
    const ccCallsToday = todayCalls
      .filter((l) => l.intern.team === "CALL_CENTER" || l.intern.team === "EA")
      .reduce((s, l) => s + l.callsMade, 0);

    const pendingLeaves = await this.prisma.leaveRequest.findMany({
      where: { status: "PENDING" },
      include: { intern: { select: { id: true, internId: true, name: true } } },
      orderBy: { appliedOn: "desc" },
    });

    const allInterns = await this.prisma.intern.findMany({
      where: { active: true },
      select: { id: true, name: true, internId: true, team: true },
    });
    const checkedInIds = new Set(todayAttendance.map((a) => a.internId));
    const notCheckedIn = allInterns.filter((i) => !checkedInIds.has(i.id));

    const monthCallLogs = await this.prisma.callLog.findMany({
      where: { date: { gte: monthStart, lte: monthEnd } },
      include: { intern: { select: { id: true, internId: true, name: true, team: true } } },
    });

    const leaderboard = new Map<string, { name: string; internId: string; team: string; totalCalls: number; totalTours: number; interested: number }>();
    monthCallLogs.forEach((log) => {
      const existing = leaderboard.get(log.internId) || {
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
      notCheckedIn: notCheckedIn.map((i) => ({ name: i.name, team: i.team })),
      leaderboard: allLeaderboard.slice(0, 10),
      alphaLeaderboard: allLeaderboard.filter((l) => l.team === "ALPHA").slice(0, 5),
      ccLeaderboard: allLeaderboard.filter((l) => l.team === "CALL_CENTER" || l.team === "EA").slice(0, 5),
      todayCalls: todayCalls.map((l) => ({
        name: l.intern.name,
        team: l.intern.team,
        callsMade: l.callsMade,
        interested: l.interestedVisit,
        tours: l.toursMade,
      })),
    };
  }
}
