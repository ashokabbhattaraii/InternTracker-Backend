import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express, { json, urlencoded, Request, Response } from "express";
import { AppModule } from "../src/app.module";

// A single Express instance is reused across warm serverless invocations.
const server = express();

// Bootstrap Nest exactly once per container (cached across warm invocations).
let bootstrapPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  app.use(json({ limit: "50mb" }));
  app.use(urlencoded({ extended: true, limit: "50mb" }));
  app.enableCors({ origin: "*" });
  // init() wires up routes without starting an HTTP listener (Vercel owns the socket).
  await app.init();
}

export default async function handler(req: Request, res: Response): Promise<void> {
  if (!bootstrapPromise) bootstrapPromise = bootstrap();
  await bootstrapPromise;
  server(req, res);
}
