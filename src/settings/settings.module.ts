import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SettingsController } from "./settings.controller";

@Module({
  imports: [PrismaModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
