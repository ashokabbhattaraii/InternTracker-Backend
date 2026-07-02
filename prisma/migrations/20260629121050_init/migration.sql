-- CreateEnum
CREATE TYPE "Role" AS ENUM ('INTERN', 'SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('P', 'A', 'L', 'HD', 'AL', 'UL', 'CL', 'ND');

-- CreateEnum
CREATE TYPE "TourOutcome" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'ENROLLED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('AL', 'HD', 'CL');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Intern" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'INTERN',
    "shift" TEXT NOT NULL DEFAULT '9:00 AM - 5:00 PM',
    "joinDate" TIMESTAMP(3),
    "supervisor" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Intern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "checkIn" TIMESTAMP(3),
    "checkOut" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "callType" TEXT,
    "callsMade" INTEGER NOT NULL DEFAULT 0,
    "callsReceived" INTEGER NOT NULL DEFAULT 0,
    "interestedVisit" INTEGER NOT NULL DEFAULT 0,
    "interestedVisitNames" TEXT,
    "needsFollowUp" INTEGER NOT NULL DEFAULT 0,
    "followUpNames" TEXT,
    "prospects" INTEGER NOT NULL DEFAULT 0,
    "admittedOther" INTEGER NOT NULL DEFAULT 0,
    "afterResults" INTEGER NOT NULL DEFAULT 0,
    "parentDiscussion" INTEGER NOT NULL DEFAULT 0,
    "financialIssues" INTEGER NOT NULL DEFAULT 0,
    "scholarshipHesitation" INTEGER NOT NULL DEFAULT 0,
    "courseNotAvailable" INTEGER NOT NULL DEFAULT 0,
    "notInterested" INTEGER NOT NULL DEFAULT 0,
    "invalidNumbers" INTEGER NOT NULL DEFAULT 0,
    "alreadyVisited" INTEGER NOT NULL DEFAULT 0,
    "highlyInterested" INTEGER NOT NULL DEFAULT 0,
    "highlyInterestedNames" TEXT,
    "remarks" TEXT,
    "toursMade" INTEGER NOT NULL DEFAULT 0,
    "hoursWorked" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TourLog" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "visitorName" TEXT NOT NULL,
    "visitors" INTEGER NOT NULL DEFAULT 1,
    "outcome" "TourOutcome" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TourLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "LeaveType" NOT NULL,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "appliedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedOn" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiTarget" (
    "id" TEXT NOT NULL,
    "minCallsPerDay" INTEGER NOT NULL DEFAULT 15,
    "minVisitsPerWeek" INTEGER NOT NULL DEFAULT 10,
    "minToursPerMonth" INTEGER NOT NULL DEFAULT 5,
    "minAttendanceRate" INTEGER NOT NULL DEFAULT 85,
    "lateThresholdMin" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KpiTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Intern_internId_key" ON "Intern"("internId");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_internId_date_key" ON "Attendance"("internId", "date");

-- CreateIndex
CREATE INDEX "CallLog_internId_date_idx" ON "CallLog"("internId", "date");

-- CreateIndex
CREATE INDEX "TourLog_internId_date_idx" ON "TourLog"("internId", "date");

-- CreateIndex
CREATE INDEX "LeaveRequest_internId_idx" ON "LeaveRequest"("internId");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TourLog" ADD CONSTRAINT "TourLog_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
