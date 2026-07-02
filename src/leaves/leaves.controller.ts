import { Controller, Get, Post, Put, Query, Body, Param } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/leaves")
export class LeavesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(@Query("status") status?: string) {
    const where: any = {};
    if (status && status !== "all") {
      where.status = status.toUpperCase();
    }

    return this.prisma.leaveRequest.findMany({
      where,
      include: { intern: { select: { id: true, internId: true, name: true } } },
      orderBy: { appliedOn: "desc" },
    });
  }

  @Post()
  async create(
    @Body()
    body: {
      internId: string;
      date: string;
      type: "AL" | "HD" | "CL";
      reason?: string;
    },
  ) {
    return this.prisma.leaveRequest.create({
      data: {
        internId: body.internId,
        date: new Date(body.date),
        type: body.type,
        reason: body.reason,
      },
    });
  }

  @Put(":id/approve")
  async approve(@Param("id") id: string) {
    const leave = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: "APPROVED", decidedOn: new Date() },
    });

    await this.prisma.attendance.upsert({
      where: {
        internId_date: { internId: leave.internId, date: leave.date },
      },
      update: { status: leave.type as any },
      create: {
        internId: leave.internId,
        date: leave.date,
        status: leave.type as any,
      },
    });

    return leave;
  }

  @Put(":id/reject")
  async reject(@Param("id") id: string) {
    return this.prisma.leaveRequest.update({
      where: { id },
      data: { status: "REJECTED", decidedOn: new Date() },
    });
  }
}
