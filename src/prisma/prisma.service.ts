import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS ?? "500", 10);

@Injectable()
export class PrismaService
  extends PrismaClient<{ log: [{ emit: "event"; level: "query" }, { emit: "event"; level: "warn" }, { emit: "event"; level: "error" }] }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger("Prisma");

  constructor() {
    super({
      log: [
        { emit: "event", level: "query" },
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ],
    });

    this.$on("query", (e) => {
      if (e.duration > SLOW_QUERY_MS) {
        this.logger.warn(`Slow query ${e.duration}ms: ${e.query}`);
      }
    });
    this.$on("warn", (e) => this.logger.warn(e.message));
    this.$on("error", (e) => this.logger.error(e.message));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
