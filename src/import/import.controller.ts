import {
  Controller,
  Get,
  Post,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import * as XLSX from "xlsx";
import { PrismaService } from "../prisma/prisma.service";

// Scalar value fields compared to decide whether a re-imported row is unchanged
// or a correction. internId / date / submittedAt / source are stable for a given
// form submission and are therefore excluded from the comparison.
const FIELD_KEYS = [
  "callType",
  "callsMade",
  "callsReceived",
  "interestedVisit",
  "interestedVisitNames",
  "needsFollowUp",
  "followUpNames",
  "prospects",
  "admittedOther",
  "afterResults",
  "parentDiscussion",
  "financialIssues",
  "scholarshipHesitation",
  "courseNotAvailable",
  "notInterested",
  "invalidNumbers",
  "alreadyVisited",
  "highlyInterested",
  "highlyInterestedNames",
  "remarks",
  "toursMade",
  "hoursWorked",
] as const;

type FieldKey = (typeof FIELD_KEYS)[number];
type CallLogFields = Record<FieldKey, string | number | null>;

// Field coercion classes — everything else in FIELD_KEYS is an integer count.
const FLOAT_KEYS = new Set<FieldKey>(["hoursWorked"]);
const STR_KEYS = new Set<FieldKey>([
  "callType",
  "interestedVisitNames",
  "followUpNames",
  "highlyInterestedNames",
  "remarks",
]);

type MatchType = "exact" | "fuzzy" | "none";
type Classification = "new" | "updated" | "unchanged";

interface InternRef {
  id: string;
  internId: string;
  name: string;
  team: string;
}

// One row as returned by the review step and echoed back (possibly edited) on commit.
interface CommitRow {
  sheet: string;
  team: string;
  name: string;
  role?: string;
  email?: string;
  submittedAt: string; // ISO
  dateStr: string; // yyyy-mm-dd
  fields: CallLogFields;
  internId: string | null; // resolved existing intern, or null → create new
  include: boolean;
}

interface ParsedRow {
  name: string;
  team: string;
  role: string;
  email?: string;
  submittedAt: Date;
  date: Date;
  dateStr: string;
  fields: CallLogFields;
}

interface ExistingLog extends CallLogFields {
  internId: string;
  submittedAt: Date;
}

@Controller("api/import")
export class ImportController {
  constructor(private prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Preview — 100% accurate: classifies every row as new / updated / unchanged
  // by comparing against what is already in the database, keyed on the unique
  // form-submission timestamp (intern + submittedAt).
  // ---------------------------------------------------------------------------
  @Post("excel/preview")
  @UseInterceptors(FileInterceptor("file"))
  async previewExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.buildPreview(file.buffer, file.originalname, file.size);
  }

  @Post("excel/preview-url")
  async previewExcelUrl(@Body() body: { url: string }) {
    const { buffer, fileName, fileSize } = await this.fetchWorkbookFromUrl(body?.url);
    return this.buildPreview(buffer, fileName, fileSize);
  }

  private async buildPreview(buffer: Buffer, fileName: string, fileSize: number) {
    const wb = this.readWorkbook(buffer);
    const internCache = await this.loadInternCache();
    const existingByKey = await this.loadExistingLogs();

    const counts = { newRows: 0, updatedRows: 0, unchangedRows: 0 };
    const newInterns = new Set<string>();
    const byDateMap = new Map<
      string,
      { date: string; new: number; updated: number; unchanged: number; interns: Set<string> }
    >();
    const sheets: any[] = [];

    for (const sheetName of wb.SheetNames) {
      if (sheetName !== "Call Center" && sheetName !== "Alpha") continue;
      const team = sheetName === "Alpha" ? "ALPHA" : "CALL_CENTER";
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]) as Record<string, any>[];

      const sheetInternNames = new Set<string>();
      const dates: string[] = [];
      let totalCalls = 0;
      let totalInterested = 0;
      let totalTours = 0;
      const sampleRows: any[] = [];

      for (const raw of data) {
        const parsed = this.parseRow(raw, team);
        if (!parsed) continue;

        sheetInternNames.add(parsed.name);
        dates.push(parsed.dateStr);
        totalCalls += parsed.fields.callsMade as number;
        totalInterested += parsed.fields.interestedVisit as number;
        totalTours += parsed.fields.toursMade as number;
        if (sampleRows.length < 5) {
          sampleRows.push({
            name: parsed.name,
            date: parsed.dateStr,
            callsMade: parsed.fields.callsMade,
            callsReceived: parsed.fields.callsReceived,
            interested: parsed.fields.interestedVisit,
            hours: parsed.fields.hoursWorked,
          });
        }

        const intern = this.resolveIntern(parsed.name, internCache);
        const bucket = this.dateBucket(byDateMap, parsed.dateStr);
        bucket.interns.add(parsed.name);

        let cls: "new" | "updated" | "unchanged";
        if (!intern) {
          // Unknown intern → a brand new submission for a new person.
          newInterns.add(this.nameKey(parsed.name));
          cls = "new";
        } else {
          cls = this.classify(intern.id, parsed, existingByKey);
        }

        if (cls === "new") {
          counts.newRows++;
          bucket.new++;
        } else if (cls === "updated") {
          counts.updatedRows++;
          bucket.updated++;
        } else {
          counts.unchangedRows++;
          bucket.unchanged++;
        }
      }

      dates.sort();
      sheets.push({
        name: sheetName,
        team,
        rows: data.length,
        uniqueInterns: [...sheetInternNames],
        internCount: sheetInternNames.size,
        dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
        stats: { totalCalls, totalInterested, totalTours },
        sampleRows,
      });
    }

    const byDate = [...byDateMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        new: b.new,
        updated: b.updated,
        unchanged: b.unchanged,
        internsReporting: b.interns.size,
      }));

    const existingInterns = await this.prisma.intern.count();
    const existingLogs = await this.prisma.callLog.count();
    const lastImport = await this.prisma.importBatch.findFirst({
      orderBy: { importedAt: "desc" },
    });

    return {
      fileName,
      fileSize,
      sheetsFound: sheets.map((s) => s.name),
      sheets,
      existingData: { interns: existingInterns, callLogs: existingLogs },
      counts: {
        newRows: counts.newRows,
        updatedRows: counts.updatedRows,
        unchangedRows: counts.unchangedRows,
        totalRows: counts.newRows + counts.updatedRows + counts.unchangedRows,
        newInternCount: newInterns.size,
      },
      byDate,
      lastImport,
    };
  }

  // ---------------------------------------------------------------------------
  // Import — upsert by (intern, submittedAt): create new, update corrected,
  // skip unchanged. Records one ImportBatch summarizing the run.
  // ---------------------------------------------------------------------------
  @Post("excel")
  @UseInterceptors(FileInterceptor("file"))
  async importExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.runImport(file.buffer, file.originalname, file.size);
  }

  @Post("excel/url")
  async importExcelUrl(@Body() body: { url: string }) {
    const { buffer, fileName, fileSize } = await this.fetchWorkbookFromUrl(body?.url);
    return this.runImport(buffer, fileName, fileSize);
  }

  private async runImport(buffer: Buffer, fileName: string, fileSize: number) {
    const wb = this.readWorkbook(buffer);
    const internCache = await this.loadInternCache();
    const existingByKey = await this.loadExistingLogs();

    const result = {
      created: 0,
      updated: 0,
      skipped: 0,
      newInterns: 0,
      dateFrom: null as string | null,
      dateTo: null as string | null,
      errors: [] as string[],
    };
    const allDates: string[] = [];
    const sheetsTouched: string[] = [];

    for (const sheetName of wb.SheetNames) {
      if (sheetName !== "Call Center" && sheetName !== "Alpha") continue;
      sheetsTouched.push(sheetName);
      const team = sheetName === "Alpha" ? "ALPHA" : "CALL_CENTER";
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]) as Record<string, any>[];

      for (const raw of data) {
        try {
          const parsed = this.parseRow(raw, team);
          if (!parsed) continue;
          allDates.push(parsed.dateStr);

          let intern = this.resolveIntern(parsed.name, internCache);
          if (!intern) {
            intern = await this.createIntern(parsed);
            internCache.set(this.nameKey(parsed.name), intern);
            result.newInterns++;
          }

          const cls = this.classify(intern.id, parsed, existingByKey);
          if (cls === "unchanged") {
            result.skipped++;
            continue;
          }

          await this.prisma.callLog.upsert({
            where: {
              internId_submittedAt: {
                internId: intern.id,
                submittedAt: parsed.submittedAt,
              },
            },
            create: {
              internId: intern.id,
              date: parsed.date,
              submittedAt: parsed.submittedAt,
              source: team,
              ...(parsed.fields as any),
            },
            update: { date: parsed.date, ...(parsed.fields as any) },
          });

          // keep in-memory map current so duplicate rows within one file dedupe
          existingByKey.set(this.logKey(intern.id, parsed.submittedAt), {
            internId: intern.id,
            submittedAt: parsed.submittedAt,
            ...parsed.fields,
          });

          if (cls === "new") result.created++;
          else result.updated++;
        } catch (e: any) {
          result.errors.push(`Row error (${raw["Full Name"]}): ${e.message}`);
        }
      }
    }

    allDates.sort();
    result.dateFrom = allDates[0] ?? null;
    result.dateTo = allDates[allDates.length - 1] ?? null;

    await this.prisma.importBatch.create({
      data: {
        fileName,
        fileSize,
        createdCount: result.created,
        updatedCount: result.updated,
        skippedCount: result.skipped,
        newInternCount: result.newInterns,
        dateFrom: result.dateFrom ? new Date(result.dateFrom) : null,
        dateTo: result.dateTo ? new Date(result.dateTo) : null,
        sheets: sheetsTouched.join(", "),
      },
    });

    return result;
  }

  @Get("history")
  async history() {
    return this.prisma.importBatch.findMany({
      orderBy: { importedAt: "desc" },
      take: 20,
    });
  }

  // ---------------------------------------------------------------------------
  // Review — like preview, but returns every parsed row with its resolved intern
  // match, remap candidates, editable field values, and classification. This is
  // what the editable import screen loads before the user commits.
  // ---------------------------------------------------------------------------
  @Post("excel/review")
  @UseInterceptors(FileInterceptor("file"))
  async reviewExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.buildReview(file.buffer, file.originalname, file.size);
  }

  @Post("excel/review-url")
  async reviewExcelUrl(@Body() body: { url: string }) {
    const { buffer, fileName, fileSize } = await this.fetchWorkbookFromUrl(body?.url);
    return this.buildReview(buffer, fileName, fileSize);
  }

  private async buildReview(buffer: Buffer, fileName: string, fileSize: number) {
    const wb = this.readWorkbook(buffer);
    const internCache = await this.loadInternCache();
    const existingByKey = await this.loadExistingLogs();
    const interns = await this.prisma.intern.findMany({
      select: { id: true, internId: true, name: true, team: true },
      orderBy: { name: "asc" },
    });

    const rows: any[] = [];
    const counts = { newRows: 0, updatedRows: 0, unchangedRows: 0, unmatched: 0 };

    for (const sheetName of wb.SheetNames) {
      if (sheetName !== "Call Center" && sheetName !== "Alpha") continue;
      const team = sheetName === "Alpha" ? "ALPHA" : "CALL_CENTER";
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]) as Record<string, any>[];

      for (const raw of data) {
        const parsed = this.parseRow(raw, team);
        if (!parsed) continue;

        const { intern, matchType } = this.matchWithType(parsed.name, internCache);
        const internId = intern?.id ?? null;

        let classification: Classification;
        let existingFields: CallLogFields | null = null;
        if (!internId) {
          classification = "new";
          counts.unmatched++;
        } else {
          const existing = existingByKey.get(this.logKey(internId, parsed.submittedAt));
          if (!existing) {
            classification = "new";
          } else {
            existingFields = this.pickFields(existing);
            classification = this.fieldsEqual(existing, parsed.fields) ? "unchanged" : "updated";
          }
        }

        if (classification === "new") counts.newRows++;
        else if (classification === "updated") counts.updatedRows++;
        else counts.unchangedRows++;

        rows.push({
          index: rows.length,
          sheet: sheetName,
          team,
          name: parsed.name,
          role: parsed.role,
          email: parsed.email ?? null,
          submittedAt: parsed.submittedAt.toISOString(),
          dateStr: parsed.dateStr,
          fields: parsed.fields,
          existingFields,
          matchInternId: internId,
          matchName: intern?.name ?? null,
          matchType,
          classification,
          candidates: this.topCandidates(parsed.name, internCache),
        });
      }
    }

    return {
      fileName,
      fileSize,
      sheetsFound: [...new Set(rows.map((r) => r.sheet))],
      interns,
      rows,
      counts: {
        ...counts,
        totalRows: rows.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Commit — take the reviewed (and possibly edited / remapped) rows and persist
  // them. internId=null means "create a new intern from this row". Field values
  // are trusted from the client but re-coerced to stable shapes first.
  // ---------------------------------------------------------------------------
  @Post("excel/commit")
  async commitReview(@Body() body: { fileName?: string; fileSize?: number; rows: CommitRow[] }) {
    if (!body?.rows?.length) throw new BadRequestException("No rows to import");

    const internCache = await this.loadInternCache();
    const existingByKey = await this.loadExistingLogs();

    const result = {
      created: 0,
      updated: 0,
      skipped: 0,
      newInterns: 0,
      dateFrom: null as string | null,
      dateTo: null as string | null,
      errors: [] as string[],
    };
    const allDates: string[] = [];
    const sheets = new Set<string>();

    for (const row of body.rows) {
      if (!row.include) continue;
      try {
        const submittedAt = new Date(row.submittedAt);
        if (isNaN(submittedAt.getTime())) throw new Error("Invalid timestamp");
        const date = new Date(`${row.dateStr}T00:00:00.000Z`);
        const fields = this.coerceFields(row.fields);
        if (row.sheet) sheets.add(row.sheet);
        allDates.push(row.dateStr);

        // Resolve / create the intern.
        let internId = row.internId;
        if (!internId) {
          const key = this.nameKey(row.name);
          const cached = internCache.get(key);
          if (cached) {
            internId = cached.id;
          } else {
            const created = await this.createIntern({
              name: row.name,
              team: row.team,
              role: row.role,
              email: row.email,
            });
            internCache.set(key, created);
            internId = created.id;
            result.newInterns++;
          }
        }

        const cls = this.classify(internId, { submittedAt, fields }, existingByKey);
        if (cls === "unchanged") {
          result.skipped++;
          continue;
        }

        await this.prisma.callLog.upsert({
          where: { internId_submittedAt: { internId, submittedAt } },
          create: {
            internId,
            date,
            submittedAt,
            source: row.team,
            ...(fields as any),
          },
          update: { date, ...(fields as any) },
        });

        existingByKey.set(this.logKey(internId, submittedAt), {
          internId,
          submittedAt,
          ...fields,
        });

        if (cls === "new") result.created++;
        else result.updated++;
      } catch (e: any) {
        result.errors.push(`Row error (${row.name}): ${e.message}`);
      }
    }

    allDates.sort();
    result.dateFrom = allDates[0] ?? null;
    result.dateTo = allDates[allDates.length - 1] ?? null;

    await this.prisma.importBatch.create({
      data: {
        fileName: body.fileName || "Edited import",
        fileSize: body.fileSize || 0,
        createdCount: result.created,
        updatedCount: result.updated,
        skippedCount: result.skipped,
        newInternCount: result.newInterns,
        dateFrom: result.dateFrom ? new Date(result.dateFrom) : null,
        dateTo: result.dateTo ? new Date(result.dateTo) : null,
        sheets: [...sheets].join(", "),
      },
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private readWorkbook(buffer: Buffer): XLSX.WorkBook {
    try {
      return XLSX.read(buffer, { type: "buffer" });
    } catch {
      throw new BadRequestException(
        "Could not read the spreadsheet. Make sure the link points to a real .xlsx file or a publicly shared Google Sheet.",
      );
    }
  }

  // Fetches an .xlsx from a URL. Google Sheets "edit" links are auto-converted to
  // their xlsx export endpoint. The sheet/file must be publicly accessible.
  private async fetchWorkbookFromUrl(
    url?: string,
  ): Promise<{ buffer: Buffer; fileName: string; fileSize: number }> {
    if (!url || !url.trim()) throw new BadRequestException("No link provided");
    const resolved = this.resolveSheetUrl(url.trim());

    let res: Response;
    try {
      res = await fetch(resolved, { redirect: "follow" });
    } catch {
      throw new BadRequestException("Could not reach that link.");
    }
    if (!res.ok) {
      throw new BadRequestException(
        `Link returned ${res.status}. If it's a Google Sheet, set sharing to "Anyone with the link".`,
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      throw new BadRequestException(
        'That link returned a web page, not a file. For Google Sheets, share as "Anyone with the link", or paste a direct .xlsx URL.',
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const fileName = this.fileNameFromUrl(resolved);
    return { buffer, fileName, fileSize: buffer.length };
  }

  private resolveSheetUrl(url: string): string {
    const gsheet = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (gsheet) {
      const id = gsheet[1];
      const gidMatch = url.match(/[?#&]gid=([0-9]+)/);
      const gid = gidMatch ? `&gid=${gidMatch[1]}` : "";
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx${gid}`;
    }
    return url;
  }

  private fileNameFromUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.hostname.includes("docs.google.com")) return "Google Sheet.xlsx";
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      return last && /\.xls[xm]?$/i.test(last) ? last : "Imported Sheet.xlsx";
    } catch {
      return "Imported Sheet.xlsx";
    }
  }

  private async loadInternCache() {
    const cache = new Map<string, InternRef>();
    const existing = await this.prisma.intern.findMany({
      select: { id: true, internId: true, name: true, team: true },
    });
    for (const i of existing) cache.set(this.nameKey(i.name), { ...i, team: i.team });
    return cache;
  }

  private async loadExistingLogs() {
    const select: any = { internId: true, submittedAt: true };
    for (const k of FIELD_KEYS) select[k] = true;
    const logs = (await this.prisma.callLog.findMany({ select })) as unknown as ExistingLog[];
    const map = new Map<string, ExistingLog>();
    for (const l of logs) map.set(this.logKey(l.internId, l.submittedAt), l);
    return map;
  }

  private async createIntern(parsed: {
    name: string;
    team: string;
    role?: string;
    email?: string;
  }): Promise<InternRef> {
    const internCount = await this.prisma.intern.count();
    const internId = `INT-${String(internCount + 1).padStart(3, "0")}`;
    const role = parsed.role === "EA" ? "SUPERVISOR" : "INTERN";
    const teamEnum = parsed.role === "EA" ? "EA" : parsed.team;
    const created = await this.prisma.intern.create({
      data: {
        internId,
        name: parsed.name,
        email: parsed.email || undefined,
        role: role as any,
        team: teamEnum as any,
      },
    });
    return { id: created.id, internId: created.internId, name: created.name, team: created.team };
  }

  private resolveIntern(name: string, cache: Map<string, InternRef>) {
    return cache.get(this.nameKey(name)) || this.findBestMatch(name, cache);
  }

  // Like resolveIntern, but also reports how the match was made (for the review UI).
  private matchWithType(
    name: string,
    cache: Map<string, InternRef>,
  ): { intern: InternRef | null; matchType: MatchType } {
    const exact = cache.get(this.nameKey(name));
    if (exact) return { intern: exact, matchType: "exact" };
    const fuzzy = this.findBestMatch(name, cache);
    return fuzzy ? { intern: fuzzy, matchType: "fuzzy" } : { intern: null, matchType: "none" };
  }

  // Best few existing interns for a name, ranked by similarity — powers the remap dropdown.
  private topCandidates(name: string, cache: Map<string, InternRef>, n = 6): InternRef[] {
    const key = this.nameKey(name);
    return [...cache.values()]
      .map((intern) => ({ intern, score: this.similarity(key, this.nameKey(intern.name)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((c) => c.intern);
  }

  private classify(
    internId: string,
    parsed: { submittedAt: Date; fields: CallLogFields },
    existingByKey: Map<string, ExistingLog>,
  ): Classification {
    const existing = existingByKey.get(this.logKey(internId, parsed.submittedAt));
    if (!existing) return "new";
    return this.fieldsEqual(existing, parsed.fields) ? "unchanged" : "updated";
  }

  private fieldsEqual(a: CallLogFields, b: CallLogFields): boolean {
    for (const k of FIELD_KEYS) {
      if ((a[k] ?? null) !== (b[k] ?? null)) return false;
    }
    return true;
  }

  // Normalize client-sent field values to the same shapes the DB / parser produce,
  // so classification comparisons stay exact after inline edits.
  private coerceFields(raw: Record<string, any> | undefined): CallLogFields {
    const out = {} as CallLogFields;
    for (const k of FIELD_KEYS) {
      const v = raw?.[k];
      if (STR_KEYS.has(k)) out[k] = this.toStr(v);
      else if (FLOAT_KEYS.has(k)) out[k] = this.toFloat(v);
      else out[k] = this.toInt(v);
    }
    return out;
  }

  private pickFields(src: Record<string, any>): CallLogFields {
    const out = {} as CallLogFields;
    for (const k of FIELD_KEYS) out[k] = src[k] ?? null;
    return out;
  }

  private parseRow(row: Record<string, any>, team: string): ParsedRow | null {
    const rawName = (row["Full Name"] || "").toString().trim();
    if (!rawName) return null;
    const timestamp = row["Timestamp"];
    if (timestamp == null || timestamp === "") return null;

    const submittedAt = this.parseTimestamp(timestamp);
    if (!submittedAt) return null;
    // Store the calendar day at UTC midnight so @db.Date round-trips to the same
    // day everywhere (matches how attendance dates are stored/compared).
    const date = new Date(
      Date.UTC(
        submittedAt.getFullYear(),
        submittedAt.getMonth(),
        submittedAt.getDate(),
      ),
    );

    return {
      name: this.normalizeName(rawName),
      team,
      role: row["Role"]?.toString().trim() || "",
      email: row["Email Address"] ? row["Email Address"].toString().trim() : undefined,
      submittedAt,
      date,
      dateStr: this.dateToStr(date),
      fields: this.extractFields(row),
    };
  }

  private extractFields(row: Record<string, any>): CallLogFields {
    return {
      callType: this.toStr(row["Choose the calls made"] || row["Choose the calls made to:"]),
      callsMade: this.toInt(row["Total Calls Made"] || row["Total No of Calls Made "]),
      callsReceived: this.toInt(row["Total Calls Received"] || row["Total No of Calls Received"]),
      interestedVisit: this.toInt(
        row["Total No. of Interested for College Visit (Tomorrow)"] ||
          row["Total No. of Interested Students for College Visit (Tomorrow) "],
      ),
      interestedVisitNames: this.toStr(
        row["Interested for College Visit (Tomorrow)\nWrite down the student's name"] ||
          row["Interested for College Visit (Tomorrow) "],
      ),
      needsFollowUp: this.toInt(
        row["Total No. of students who are Interested but needs to follow-up"] ||
          row["Total No. of students who are Interested but needs follow-up."],
      ),
      followUpNames: this.toStr(
        row["Name of students who are Interested but needs to follow-up\nWrite down the student's name"] ||
          row["Name of students who are Interested but needs follow-up."],
      ),
      prospects: this.toInt(row["Total No of Prospects from Today's Call"]),
      admittedOther: this.toInt(row["Total No of Students admitted to other college from Today's Calls"]),
      afterResults: this.toInt(
        row["Total No of Students who will come/make decision after results \nAfter their results/ results waiting from any other streams- e.g.; nursing, medical, IOE, etc."] ||
          row["Total No of students who will come/make decision after results"],
      ),
      parentDiscussion: this.toInt(row["Total No of Students to discuss with their parents for decision from Today's Calls"]),
      financialIssues: this.toInt(row["Total No of Students stating Financial Issues from Today's Calls"]),
      scholarshipHesitation: this.toInt(row["Total No of Students having Scholarship-related hesitation from Today's Calls."]),
      courseNotAvailable: this.toInt(
        row["Course not available \nWrite down the total number of students who seeked a different course from HCK course - e.g.: besides BCS/BCY/ BIBM and IMBA\n"] ||
          row["Course not available -"],
      ),
      notInterested: this.toInt(row["Total No of Not Interested from Today's Calls"]),
      invalidNumbers: this.toInt(
        row["Total No. of Invalid/ Wrong Number from Today's Calls"] ||
          row["Total No. of Invalid/ Wrong Number from Today's Calls."],
      ),
      alreadyVisited: this.toInt(
        row["Total No of Students who already visited the college"] ||
          row["Total No of Students who already visited the college "],
      ),
      highlyInterested: this.toInt(
        row["Total No of Highly Interested Students for Admission (Cat 9) - Pipeline\nWrite down the total number"],
      ),
      highlyInterestedNames: this.toStr(
        row["Highly Interested in Admissions (Cat 9) - Pipeline\nWrite down the student's name"],
      ),
      remarks: this.toStr(
        row["Average Remarks from Calls*\nYou ought to write the average remarks received from the calls made"] ||
          row["Average Remarks from Calls"],
      ),
      toursMade: this.toInt(row["Total number of College Tours made Today"]),
      hoursWorked: this.toFloat(row["Total Hours worked Today"]),
    };
  }

  private logKey(internId: string, submittedAt: Date): string {
    return `${internId}|${submittedAt.getTime()}`;
  }

  private dateBucket(
    map: Map<
      string,
      { date: string; new: number; updated: number; unchanged: number; interns: Set<string> }
    >,
    dateStr: string,
  ) {
    let b = map.get(dateStr);
    if (!b) {
      b = { date: dateStr, new: 0, updated: 0, unchanged: 0, interns: new Set() };
      map.set(dateStr, b);
    }
    return b;
  }

  private findBestMatch(name: string, cache: Map<string, InternRef>): InternRef | null {
    const key = this.nameKey(name);
    if (cache.has(key)) return cache.get(key)!;

    let best: InternRef | null = null;
    let bestScore = 0;
    const firstName = name.toLowerCase().split(/\s+/)[0];

    for (const [existingKey, intern] of cache.entries()) {
      const existingFirst = intern.name.toLowerCase().split(/\s+/)[0];
      if (firstName === existingFirst && firstName.length >= 4) return intern;
      if (
        (existingKey.includes(key) || key.includes(existingKey)) &&
        Math.min(key.length, existingKey.length) >= 4
      )
        return intern;
      const score = this.similarity(key, existingKey);
      if (score > bestScore && score >= 0.82) {
        bestScore = score;
        best = intern;
      }
    }
    return best;
  }

  private similarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    return (longer.length - this.editDistance(longer, shorter)) / longer.length;
  }

  private editDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] =
          b[i - 1] === a[j - 1]
            ? matrix[i - 1][j - 1]
            : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }

  private normalizeName(name: string): string {
    return name
      .replace(/,+$/, "")
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  private nameKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z]/g, "");
  }

  private parseTimestamp(timestamp: any): Date | null {
    let date: Date;
    if (typeof timestamp === "number") {
      // Excel serial → ms epoch, rounded to whole seconds so the same submission
      // produces an identical, stable submittedAt on every import.
      const ms = Math.round((timestamp - 25569) * 86400) * 1000;
      date = new Date(ms);
    } else {
      date = new Date(timestamp);
    }
    return isNaN(date.getTime()) ? null : date;
  }

  private dateToStr(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private toInt(val: any): number {
    if (val == null || val === "") return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

  private toFloat(val: any): number {
    if (val == null || val === "") return 0;
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }

  private toStr(val: any): string | null {
    if (val == null || val === 0) return null;
    const s = val.toString().trim();
    return s || null;
  }
}
