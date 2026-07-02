import { Module } from "@nestjs/common";
import { CallLogsController } from "./call-logs.controller";

@Module({
  controllers: [CallLogsController],
})
export class CallLogsModule {}
