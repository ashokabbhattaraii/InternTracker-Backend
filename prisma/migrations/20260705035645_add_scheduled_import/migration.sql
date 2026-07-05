-- CreateTable
CREATE TABLE "ScheduledImport" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "time" TEXT NOT NULL DEFAULT '18:30',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledImport_pkey" PRIMARY KEY ("id")
);
