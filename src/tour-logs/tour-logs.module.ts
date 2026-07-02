import { Module } from "@nestjs/common";
import { TourLogsController } from "./tour-logs.controller";

@Module({
  controllers: [TourLogsController],
})
export class TourLogsModule {}
