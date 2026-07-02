-- CreateEnum
CREATE TYPE "Team" AS ENUM ('ALPHA', 'CALL_CENTER', 'EA');

-- AlterTable
ALTER TABLE "Intern" ADD COLUMN     "team" "Team" NOT NULL DEFAULT 'CALL_CENTER';
