import { Controller, Get, Post, Body } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/settings")
export class SettingsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async getSettings() {
    let settings = await this.prisma.kpiTarget.findFirst();
    if (!settings) {
      settings = await this.prisma.kpiTarget.create({ data: {} });
    }
    return {
      kpiTargets: {
        minCallsPerDay: settings.minCallsPerDay,
        minVisitsPerWeek: settings.minVisitsPerWeek,
        minToursPerMonth: settings.minToursPerMonth,
        minAttendanceRate: settings.minAttendanceRate,
      },
      shift: {
        lateThresholdMin: settings.lateThresholdMin,
        sessionTimeoutMin: settings.sessionTimeoutMin,
      },
      notifications: {
        late: settings.notifyLate,
        absent: settings.notifyAbsent,
        pattern: settings.notifyPattern,
        kpi: settings.notifyKpi,
        pending: settings.notifyPending,
      },
    };
  }

  @Post()
  async saveSettings(
    @Body()
    body: {
      kpiTargets?: {
        minCallsPerDay?: number;
        minVisitsPerWeek?: number;
        minToursPerMonth?: number;
        minAttendanceRate?: number;
      };
      shift?: {
        lateThresholdMin?: number;
        sessionTimeoutMin?: number;
      };
      notifications?: {
        late?: boolean;
        absent?: boolean;
        pattern?: boolean;
        kpi?: boolean;
        pending?: boolean;
      };
    },
  ) {
    let existing = await this.prisma.kpiTarget.findFirst();
    const data: any = {};

    if (body.kpiTargets) {
      if (body.kpiTargets.minCallsPerDay !== undefined) data.minCallsPerDay = body.kpiTargets.minCallsPerDay;
      if (body.kpiTargets.minVisitsPerWeek !== undefined) data.minVisitsPerWeek = body.kpiTargets.minVisitsPerWeek;
      if (body.kpiTargets.minToursPerMonth !== undefined) data.minToursPerMonth = body.kpiTargets.minToursPerMonth;
      if (body.kpiTargets.minAttendanceRate !== undefined) data.minAttendanceRate = body.kpiTargets.minAttendanceRate;
    }

    if (body.shift) {
      if (body.shift.lateThresholdMin !== undefined) data.lateThresholdMin = body.shift.lateThresholdMin;
      if (body.shift.sessionTimeoutMin !== undefined) data.sessionTimeoutMin = body.shift.sessionTimeoutMin;
    }

    if (body.notifications) {
      if (body.notifications.late !== undefined) data.notifyLate = body.notifications.late;
      if (body.notifications.absent !== undefined) data.notifyAbsent = body.notifications.absent;
      if (body.notifications.pattern !== undefined) data.notifyPattern = body.notifications.pattern;
      if (body.notifications.kpi !== undefined) data.notifyKpi = body.notifications.kpi;
      if (body.notifications.pending !== undefined) data.notifyPending = body.notifications.pending;
    }

    if (existing) {
      existing = await this.prisma.kpiTarget.update({
        where: { id: existing.id },
        data,
      });
    } else {
      existing = await this.prisma.kpiTarget.create({ data });
    }

    return {
      kpiTargets: {
        minCallsPerDay: existing.minCallsPerDay,
        minVisitsPerWeek: existing.minVisitsPerWeek,
        minToursPerMonth: existing.minToursPerMonth,
        minAttendanceRate: existing.minAttendanceRate,
      },
      shift: {
        lateThresholdMin: existing.lateThresholdMin,
        sessionTimeoutMin: existing.sessionTimeoutMin,
      },
      notifications: {
        late: existing.notifyLate,
        absent: existing.notifyAbsent,
        pattern: existing.notifyPattern,
        kpi: existing.notifyKpi,
        pending: existing.notifyPending,
      },
    };
  }
}
