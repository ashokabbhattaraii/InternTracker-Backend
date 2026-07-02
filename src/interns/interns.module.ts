import { Module } from "@nestjs/common";
import { InternsController } from "./interns.controller";

@Module({
  controllers: [InternsController],
})
export class InternsModule {}
