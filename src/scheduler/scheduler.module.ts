import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "../prisma/prisma.module";
import { SchedulerService } from "./scheduler.service";
import { SchedulerController } from "./scheduler.controller";

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule],
  providers: [SchedulerService],
  controllers: [SchedulerController],
})
export class SchedulerModule {}
