import { Controller, Get, Post, Query, Body } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/call-logs")
export class CallLogsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(
    @Query("date") date?: string,
    @Query("internId") internId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const where: any = {};

    if (date) {
      where.date = new Date(date);
    } else if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    if (internId) {
      where.internId = internId;
    }

    return this.prisma.callLog.findMany({
      where,
      include: { intern: { select: { id: true, internId: true, name: true, team: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
  }

  @Get("summary")
  async summary(
    @Query("month") month?: string,
    @Query("year") year?: string,
  ) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 0);

    const logs = await this.prisma.callLog.findMany({
      where: { date: { gte: startDate, lte: endDate } },
      include: { intern: { select: { id: true, internId: true, name: true, team: true } } },
    });

    const byIntern = new Map<
      string,
      { intern: any; totalCalls: number; totalReceived: number; totalInterested: number; totalTours: number; totalFollowUp: number; totalProspects: number; days: number }
    >();

    logs.forEach((log) => {
      const key = log.internId;
      const existing = byIntern.get(key) || {
        intern: log.intern,
        totalCalls: 0,
        totalReceived: 0,
        totalInterested: 0,
        totalTours: 0,
        totalFollowUp: 0,
        totalProspects: 0,
        days: 0,
      };
      existing.totalCalls += log.callsMade;
      existing.totalReceived += log.callsReceived;
      existing.totalInterested += log.interestedVisit;
      existing.totalTours += log.toursMade;
      existing.totalFollowUp += log.needsFollowUp;
      existing.totalProspects += log.prospects;
      existing.days += 1;
      byIntern.set(key, existing);
    });

    const allInterns = Array.from(byIntern.values()).sort(
      (a, b) => b.totalCalls - a.totalCalls,
    );

    return {
      month: m + 1,
      year: y,
      totalLogs: logs.length,
      totalCalls: logs.reduce((s, l) => s + l.callsMade, 0),
      totalInterested: logs.reduce((s, l) => s + l.interestedVisit, 0),
      totalTours: logs.reduce((s, l) => s + l.toursMade, 0),
      byIntern: allInterns,
      byTeam: {
        alpha: allInterns.filter((i) => i.intern.team === "ALPHA"),
        callCenter: allInterns.filter((i) => i.intern.team === "CALL_CENTER" || i.intern.team === "EA"),
      },
    };
  }

  @Post()
  async create(
    @Body()
    body: {
      internId: string;
      date: string;
      callType?: string;
      callsMade: number;
      callsReceived?: number;
      interestedVisit?: number;
      interestedVisitNames?: string;
      needsFollowUp?: number;
      followUpNames?: string;
      prospects?: number;
      admittedOther?: number;
      afterResults?: number;
      parentDiscussion?: number;
      financialIssues?: number;
      scholarshipHesitation?: number;
      courseNotAvailable?: number;
      notInterested?: number;
      invalidNumbers?: number;
      alreadyVisited?: number;
      highlyInterested?: number;
      highlyInterestedNames?: string;
      remarks?: string;
      toursMade?: number;
      hoursWorked?: number;
    },
  ) {
    return this.prisma.callLog.create({
      data: {
        ...body,
        date: new Date(body.date),
        submittedAt: new Date(),
        source: "MANUAL",
      },
    });
  }
}
