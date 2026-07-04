// Bikram Sambat (BS) date conversion utility
// Covers BS years 2080–2090 (approx AD 2023–2033)

export interface NepaliDate {
  year: number;
  month: number;
  day: number;
}

export const BS_MONTHS = [
  "Baishakh",
  "Jestha",
  "Asadh",
  "Shrawan",
  "Bhadra",
  "Ashwin",
  "Kartik",
  "Mangsir",
  "Poush",
  "Magh",
  "Falgun",
  "Chaitra",
];

const BS_CALENDAR_DATA: Record<number, number[]> = {
  2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2081: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2082: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2083: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2084: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2085: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2086: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2087: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2088: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2089: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2090: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
};

// Reference point: BS 2080-01-01 = AD 2023-04-14
const BS_REF = { year: 2080, month: 1, day: 1 };
const AD_REF = new Date(Date.UTC(2023, 3, 14)); // April 14, 2023

function totalDaysInBsYear(year: number): number {
  const data = BS_CALENDAR_DATA[year];
  if (!data) throw new Error(`BS year ${year} not supported`);
  return data.reduce((sum, d) => sum + d, 0);
}

function daysInBsMonth(year: number, month: number): number {
  const data = BS_CALENDAR_DATA[year];
  if (!data) throw new Error(`BS year ${year} not supported`);
  return data[month - 1];
}

export function adToBS(adDate: Date): NepaliDate {
  const utcDate = Date.UTC(
    adDate.getUTCFullYear(),
    adDate.getUTCMonth(),
    adDate.getUTCDate(),
  );
  const refUtc = AD_REF.getTime();
  let daysDiff = Math.floor((utcDate - refUtc) / 86400000);

  let bsYear = BS_REF.year;
  let bsMonth = BS_REF.month;
  let bsDay = BS_REF.day;

  if (daysDiff >= 0) {
    // Forward from reference
    while (daysDiff > 0) {
      const daysInMonth = daysInBsMonth(bsYear, bsMonth);
      const daysLeftInMonth = daysInMonth - bsDay;
      if (daysDiff <= daysLeftInMonth) {
        bsDay += daysDiff;
        daysDiff = 0;
      } else {
        daysDiff -= daysLeftInMonth + 1;
        bsMonth++;
        if (bsMonth > 12) {
          bsMonth = 1;
          bsYear++;
        }
        bsDay = 1;
      }
    }
  } else {
    // Backward from reference
    daysDiff = Math.abs(daysDiff);
    while (daysDiff > 0) {
      if (daysDiff < bsDay) {
        bsDay -= daysDiff;
        daysDiff = 0;
      } else {
        daysDiff -= bsDay;
        bsMonth--;
        if (bsMonth < 1) {
          bsMonth = 12;
          bsYear--;
        }
        bsDay = daysInBsMonth(bsYear, bsMonth);
      }
    }
  }

  return { year: bsYear, month: bsMonth, day: bsDay };
}

export function bsToAD(bs: NepaliDate): Date {
  let totalDays = 0;

  // Count days from reference BS date to target BS date
  if (
    bs.year > BS_REF.year ||
    (bs.year === BS_REF.year && bs.month > BS_REF.month) ||
    (bs.year === BS_REF.year && bs.month === BS_REF.month && bs.day >= BS_REF.day)
  ) {
    // Target is at or after reference
    let y = BS_REF.year;
    let m = BS_REF.month;
    let d = BS_REF.day;

    while (y < bs.year || (y === bs.year && m < bs.month)) {
      totalDays += daysInBsMonth(y, m) - d + 1;
      d = 1;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    totalDays += bs.day - d;
  } else {
    // Target is before reference
    let y = BS_REF.year;
    let m = BS_REF.month;
    let d = BS_REF.day;

    while (y > bs.year || (y === bs.year && m > bs.month)) {
      totalDays -= d;
      m--;
      if (m < 1) {
        m = 12;
        y--;
      }
      d = daysInBsMonth(y, m);
    }
    totalDays -= d - bs.day;
  }

  const result = new Date(AD_REF.getTime() + totalDays * 86400000);
  return result;
}

export function formatNepaliDate(bs: NepaliDate): string {
  return `${bs.year}-${String(bs.month).padStart(2, "0")}-${String(bs.day).padStart(2, "0")}`;
}

export function formatNepaliDateFull(bs: NepaliDate): string {
  return `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`;
}

export function getNepaliMonthRange(bsYear: number, bsMonth: number): { start: Date; end: Date } {
  const start = bsToAD({ year: bsYear, month: bsMonth, day: 1 });
  const lastDay = daysInBsMonth(bsYear, bsMonth);
  const end = bsToAD({ year: bsYear, month: bsMonth, day: lastDay });
  return { start, end };
}

export function getNepaliWeekRange(adDate: Date): { start: Date; end: Date; bsStart: NepaliDate; bsEnd: NepaliDate } {
  // Week starts on Sunday in Nepal
  const utc = Date.UTC(adDate.getUTCFullYear(), adDate.getUTCMonth(), adDate.getUTCDate());
  const dayOfWeek = new Date(utc).getUTCDay(); // 0 = Sunday
  const startUtc = utc - dayOfWeek * 86400000;
  const endUtc = startUtc + 6 * 86400000;
  const start = new Date(startUtc);
  const end = new Date(endUtc);
  return { start, end, bsStart: adToBS(start), bsEnd: adToBS(end) };
}

export function getDaysInBsMonth(year: number, month: number): number {
  return daysInBsMonth(year, month);
}

export function getCurrentNepaliDate(): NepaliDate {
  return adToBS(new Date());
}

// ASADH 1, 2082 = June 15, 2025 — attendance tracking start date
export const ATTENDANCE_START_AD = new Date(Date.UTC(2025, 5, 15));
export const ATTENDANCE_START_BS: NepaliDate = { year: 2082, month: 3, day: 1 };
