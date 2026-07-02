import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as path from "path";

const prisma = new PrismaClient();

function normalizeName(name: string): string {
  return name
    .replace(/,+$/, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function similarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const dist = editDistance(longer, shorter);
  return (longer.length - dist) / longer.length;
}

function editDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function findBestMatch(name: string, cache: Map<string, { id: string; name: string }>): { id: string; name: string } | null {
  const key = nameKey(name);
  if (cache.has(key)) return cache.get(key)!;

  let best: { id: string; name: string } | null = null;
  let bestScore = 0;

  const nameParts = name.toLowerCase().split(/\s+/);
  const firstName = nameParts[0];

  for (const [existingKey, intern] of cache.entries()) {
    // First name exact match and existing key starts with same first name
    const existingFirst = intern.name.toLowerCase().split(/\s+/)[0];
    if (firstName === existingFirst && firstName.length >= 4) {
      return intern;
    }

    // Substring containment with reasonable length ratio
    if ((existingKey.includes(key) || key.includes(existingKey)) && Math.min(key.length, existingKey.length) >= 4) {
      return intern;
    }

    const score = similarity(key, existingKey);
    if (score > bestScore && score >= 0.82) {
      bestScore = score;
      best = intern;
    }
  }
  return best;
}

function toInt(val: any): number {
  if (val == null || val === "") return 0;
  const n = parseInt(val, 10);
  return isNaN(n) ? 0 : n;
}

function toFloat(val: any): number {
  if (val == null || val === "") return 0;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function toStr(val: any): string | null {
  if (val == null || val === 0) return null;
  const s = val.toString().trim();
  return s || null;
}

async function main() {
  // Clear existing data
  await prisma.callLog.deleteMany();
  await prisma.tourLog.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.intern.deleteMany();
  console.log("Cleared existing data.");

  const filePath = path.join(
    __dirname,
    "../../docs/A26- Calls Reporting.xlsx",
  );
  const wb = XLSX.readFile(filePath);
  console.log("Sheets:", wb.SheetNames);

  const internCache = new Map<string, { id: string; name: string }>();
  let internCount = 0;
  let logCount = 0;

  for (const sheetName of wb.SheetNames) {
    if (sheetName !== "Alpha" && sheetName !== "Call Center") continue;

    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws) as Record<string, any>[];
    const team = sheetName === "Alpha" ? "ALPHA" : "CALL_CENTER";
    console.log(`\nProcessing sheet: ${sheetName} (${data.length} rows) — Team: ${team}`);

    for (const row of data) {
      const rawName = (row["Full Name"] || "").toString().trim();
      if (!rawName) continue;

      const name = normalizeName(rawName);
      const key = nameKey(name);

      let intern = internCache.get(key) || findBestMatch(name, internCache);

      if (!intern) {
        internCount++;
        const internId = `INT-${String(internCount).padStart(3, "0")}`;
        const email = row["Email Address"] ? row["Email Address"].toString().trim() : undefined;
        const roleStr = row["Role"]?.toString().trim();
        const role = roleStr === "EA" ? "SUPERVISOR" : "INTERN";
        const assignedTeam = roleStr === "EA" ? "EA" : team;

        const created = await prisma.intern.create({
          data: {
            internId,
            name,
            email: email || undefined,
            role: role as any,
            team: assignedTeam as any,
          },
        });
        intern = { id: created.id, name: created.name };
        internCache.set(key, intern);
        console.log(`  Created: ${name} (${internId}) [${assignedTeam}]`);
      } else if (!internCache.has(key)) {
        internCache.set(key, intern);
        console.log(`  Matched: "${name}" → "${intern.name}" (fuzzy)`);
      }

      const timestamp = row["Timestamp"];
      if (!timestamp) continue;

      let submittedAt: Date;
      if (typeof timestamp === "number") {
        submittedAt = new Date(Math.round((timestamp - 25569) * 86400) * 1000);
      } else {
        submittedAt = new Date(timestamp);
      }
      const dateOnly = new Date(
        Date.UTC(
          submittedAt.getFullYear(),
          submittedAt.getMonth(),
          submittedAt.getDate(),
        ),
      );

      const callsMade = toInt(
        row["Total Calls Made"] || row["Total No of Calls Made "],
      );
      const callsReceived = toInt(
        row["Total Calls Received"] || row["Total No of Calls Received"],
      );
      const interestedVisit = toInt(
        row["Total No. of Interested for College Visit (Tomorrow)"] ||
          row["Total No. of Interested Students for College Visit (Tomorrow) "],
      );
      const interestedVisitNames = toStr(
        row["Interested for College Visit (Tomorrow)\nWrite down the student's name"] ||
        row["Interested for College Visit (Tomorrow) "],
      );
      const needsFollowUp = toInt(
        row["Total No. of students who are Interested but needs to follow-up"] ||
          row["Total No. of students who are Interested but needs follow-up."],
      );
      const followUpNames = toStr(
        row["Name of students who are Interested but needs to follow-up\nWrite down the student's name"] ||
        row["Name of students who are Interested but needs follow-up."],
      );
      const prospects = toInt(
        row["Total No of Prospects from Today's Call"],
      );
      const admittedOther = toInt(
        row["Total No of Students admitted to other college from Today's Calls"],
      );
      const afterResults = toInt(
        row["Total No of Students who will come/make decision after results \nAfter their results/ results waiting from any other streams- e.g.; nursing, medical, IOE, etc."] ||
          row["Total No of students who will come/make decision after results"],
      );
      const parentDiscussion = toInt(
        row["Total No of Students to discuss with their parents for decision from Today's Calls"],
      );
      const financialIssues = toInt(
        row["Total No of Students stating Financial Issues from Today's Calls"],
      );
      const scholarshipHesitation = toInt(
        row["Total No of Students having Scholarship-related hesitation from Today's Calls."],
      );
      const courseNotAvailable = toInt(
        row["Course not available \nWrite down the total number of students who seeked a different course from HCK course - e.g.: besides BCS/BCY/ BIBM and IMBA\n"] ||
          row["Course not available -"],
      );
      const notInterested = toInt(
        row["Total No of Not Interested from Today's Calls"],
      );
      const invalidNumbers = toInt(
        row["Total No. of Invalid/ Wrong Number from Today's Calls"] ||
          row["Total No. of Invalid/ Wrong Number from Today's Calls."],
      );
      const alreadyVisited = toInt(
        row["Total No of Students who already visited the college"] ||
          row["Total No of Students who already visited the college "],
      );
      const highlyInterested = toInt(
        row["Total No of Highly Interested Students for Admission (Cat 9) - Pipeline\nWrite down the total number"],
      );
      const highlyInterestedNames = toStr(
        row["Highly Interested in Admissions (Cat 9) - Pipeline\nWrite down the student's name"],
      );
      const remarks = toStr(
        row["Average Remarks from Calls*\nYou ought to write the average remarks received from the calls made"] ||
        row["Average Remarks from Calls"],
      );
      const toursMade = toInt(
        row["Total number of College Tours made Today"],
      );
      const hoursWorked = toFloat(row["Total Hours worked Today"]);
      const callType = toStr(
        row["Choose the calls made"] || row["Choose the calls made to:"],
      );

      await prisma.callLog.create({
        data: {
          internId: intern.id,
          date: dateOnly,
          submittedAt,
          source: team,
          callType: callType || null,
          callsMade,
          callsReceived,
          interestedVisit,
          interestedVisitNames,
          needsFollowUp,
          followUpNames,
          prospects,
          admittedOther,
          afterResults,
          parentDiscussion,
          financialIssues,
          scholarshipHesitation,
          courseNotAvailable,
          notInterested,
          invalidNumbers,
          alreadyVisited,
          highlyInterested,
          highlyInterestedNames,
          remarks,
          toursMade,
          hoursWorked,
        },
      });
      logCount++;
    }
  }

  console.log(`\nDone! Created ${internCount} interns and ${logCount} call logs.`);
  console.log(`Intern breakdown:`);
  const teams = await prisma.intern.groupBy({ by: ["team"], _count: true });
  teams.forEach((t) => console.log(`  ${t.team}: ${t._count}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
