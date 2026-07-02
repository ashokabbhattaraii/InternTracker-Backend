import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { InternsModule } from "./interns/interns.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { CallLogsModule } from "./call-logs/call-logs.module";
import { TourLogsModule } from "./tour-logs/tour-logs.module";
import { LeavesModule } from "./leaves/leaves.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { ImportModule } from "./import/import.module";

@Module({
  imports: [
    PrismaModule,
    InternsModule,
    AttendanceModule,
    CallLogsModule,
    TourLogsModule,
    LeavesModule,
    DashboardModule,
    ImportModule,
  ],
})
export class AppModule {}
