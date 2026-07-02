-- AlterTable
ALTER TABLE "CallLog" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "submittedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "newInternCount" INTEGER NOT NULL DEFAULT 0,
    "dateFrom" DATE,
    "dateTo" DATE,
    "sheets" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaturdayRoster" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaturdayRoster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_importedAt_idx" ON "ImportBatch"("importedAt");

-- CreateIndex
CREATE INDEX "SaturdayRoster_date_idx" ON "SaturdayRoster"("date");

-- CreateIndex
CREATE UNIQUE INDEX "SaturdayRoster_internId_date_key" ON "SaturdayRoster"("internId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_internId_submittedAt_key" ON "CallLog"("internId", "submittedAt");

-- AddForeignKey
ALTER TABLE "SaturdayRoster" ADD CONSTRAINT "SaturdayRoster_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

