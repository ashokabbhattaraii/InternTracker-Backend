import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async checkScheduledImports() {
    const config = await this.prisma.scheduledImport.findFirst();
    if (!config || !config.enabled) return;

    const now = new Date();
    const [h, m] = config.time.split(":").map(Number);
    if (now.getHours() !== h || now.getMinutes() !== m) return;

    if (config.lastRunAt) {
      const diffMs = now.getTime() - config.lastRunAt.getTime();
      if (diffMs < 120_000) return;
    }

    this.logger.log(`Running scheduled import from: ${config.url}`);
    await this.prisma.scheduledImport.update({
      where: { id: config.id },
      data: { lastRunAt: now, lastError: null },
    });

    try {
      const port = process.env.PORT ?? 6001;
      const res = await fetch(`http://localhost:${port}/api/import/excel/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: config.url }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Import failed (${res.status}): ${text}`);
      }

      const result = await res.json();
      this.logger.log(
        `Scheduled import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
      );
    } catch (e: any) {
      this.logger.error(`Scheduled import failed: ${e.message}`);
      await this.prisma.scheduledImport.update({
        where: { id: config.id },
        data: { lastError: e.message },
      });
    }
  }
}
