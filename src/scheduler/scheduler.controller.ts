import { Controller, Get, Post, Body } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/scheduled-import")
export class SchedulerController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async getConfig() {
    const config = await this.prisma.scheduledImport.findFirst();
    return config ?? { url: "", time: "18:30", enabled: false };
  }

  @Post()
  async saveConfig(@Body() body: { url: string; time: string; enabled: boolean }) {
    const existing = await this.prisma.scheduledImport.findFirst();
    if (existing) {
      return this.prisma.scheduledImport.update({
        where: { id: existing.id },
        data: { url: body.url, time: body.time, enabled: body.enabled },
      });
    }
    return this.prisma.scheduledImport.create({
      data: { url: body.url, time: body.time, enabled: body.enabled },
    });
  }

  @Post("trigger")
  async triggerNow() {
    const config = await this.prisma.scheduledImport.findFirst();
    if (!config?.url) return { error: "No URL configured" };

    const port = process.env.PORT ?? 6001;
    const res = await fetch(`http://localhost:${port}/api/import/excel/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: config.url }),
    });

    if (!res.ok) {
      const text = await res.text();
      await this.prisma.scheduledImport.update({
        where: { id: config.id },
        data: { lastRunAt: new Date(), lastError: `Import failed (${res.status}): ${text}` },
      });
      return { error: text };
    }

    const result = await res.json();
    await this.prisma.scheduledImport.update({
      where: { id: config.id },
      data: { lastRunAt: new Date(), lastError: null },
    });
    return result;
  }
}
