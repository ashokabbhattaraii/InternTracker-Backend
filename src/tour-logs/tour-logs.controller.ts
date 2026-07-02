import { Controller, Get, Post, Query, Body } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/tour-logs")
export class TourLogsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("internId") internId?: string,
  ) {
    const where: any = {};

    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    if (internId) {
      where.internId = internId;
    }

    return this.prisma.tourLog.findMany({
      where,
      include: { intern: { select: { id: true, internId: true, name: true } } },
      orderBy: { date: "desc" },
    });
  }

  @Post()
  async create(
    @Body()
    body: {
      internId: string;
      date: string;
      visitorName: string;
      visitors?: number;
      outcome: "INTERESTED" | "NOT_INTERESTED" | "ENROLLED";
      notes?: string;
    },
  ) {
    return this.prisma.tourLog.create({
      data: {
        ...body,
        date: new Date(body.date),
        visitors: body.visitors || 1,
      },
    });
  }
}
