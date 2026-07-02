import { Module } from "@nestjs/common";
import { LeavesController } from "./leaves.controller";

@Module({
  controllers: [LeavesController],
})
export class LeavesModule {}
