// Load .env before anything else so PrismaService sees DATABASE_URL when Nest
// instantiates it. On Vercel the entry is api/index.ts and env vars are
// injected by the platform, so this local-dev bootstrap owns dotenv loading.
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { json, urlencoded } from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(json({ limit: "50mb" }));
  app.use(urlencoded({ extended: true, limit: "50mb" }));
  app.enableCors({ origin: "*" });
  await app.listen(process.env.PORT ?? 6001);
}
bootstrap();
