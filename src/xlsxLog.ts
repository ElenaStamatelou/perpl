import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { config } from "./config.js";

const LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));
mkdirSync(LOG_DIR, { recursive: true });

// Labeled per BOT_LABEL, same convention as logs/cycles.jsonl.
const LABEL_SUFFIX = config.botLabel === "default" ? "" : `.${config.botLabel}`;
// Ever-growing ledger: every close from every run/restart appends a row here.
const LIVE_XLSX_FILE = `${LOG_DIR}fees-log${LABEL_SUFFIX}.xlsx`;
// One row per run (keyed by run start time) so runs can be compared side by side.
const SUMMARY_PER_RUN_FILE = `${LOG_DIR}summary-per-run${LABEL_SUFFIX}.xlsx`;
// One row appended every ~12h of elapsed run time, so progress can be reviewed
// on a fixed cadence without waiting for a run to end or opening the live ledger.
const SUMMARY_12H_FILE = `${LOG_DIR}summary-12h${LABEL_SUFFIX}.xlsx`;

// New columns must always be appended at the END of these lists, never inserted
// in the middle - openOrCreate() only ever re-syncs row 1's labels, it never
// moves any previously-written row's cells. Inserting a column mid-list shifts
// what every old row's existing values line up against, silently mislabeling
// them under the new header (this happened once - see logs/backup-pre-repair/).
const LIVE_HEADERS = [
  "Timestamp",
  "Fees Spent ($, cumulative)",
  "Initial Deposit ($)",
  "Current Deposit ($)",
  "Volume ($, cumulative)",
  "Fees per $1M Volume ($)",
  "Run Duration (H:MM:SS)",
  "PNL ($, cumulative)",
  "Costs ($, cumulative)",
  "PNL per $1M Volume ($)",
  "Costs per $1M Volume ($)",
];

// Runs-summary uses a different sign convention than the live ledger below:
// Fees is shown NEGATIVE (money that left the deposit) and Costs = Fees + PNL,
// a net result where negative = net lost money, positive = net made money -
// reads like a bank statement line. (Live ledger keeps Costs = Fees - PNL,
// positive-when-losing, per the original request for that file.)
const RUN_SUMMARY_HEADERS = [
  "Run Start",
  "Last Update",
  "Duration (H:MM:SS)",
  "Initial Deposit ($)",
  "Current Deposit ($)",
  "Volume ($)",
  "Fees ($)",
  "PNL ($)",
  "Costs ($)",
  "Fees per $1M ($)",
  "PNL per $1M ($)",
  "Costs per $1M ($)",
  "Volume per Hour ($)",
];

// Same shape as RUN_SUMMARY_HEADERS, but "Run Start"/"Last Update" become
// "Period Start"/"Period End" since this file is a sequence of periodic
// snapshots, not one row per run.
const SUMMARY_12H_HEADERS = [
  "Period Start",
  "Period End",
  "Duration (H:MM:SS)",
  "Initial Deposit ($)",
  "Current Deposit ($)",
  "Volume ($)",
  "Fees ($)",
  "PNL ($)",
  "Costs ($)",
  "Fees per $1M ($)",
  "PNL per $1M ($)",
  "Costs per $1M ($)",
  "Volume per Hour ($)",
];

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Sheet {
  workbook: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
  filePath: string;
}

/**
 * Opens filePath if it exists (so both files accumulate across restarts) or
 * starts a fresh workbook otherwise. Row 1 only ever holds header labels,
 * never data, so it's always safe to re-sync it to the current headers - this
 * backfills new columns onto files created before they existed, without
 * touching any previously logged data rows.
 */
async function openOrCreate(filePath: string, headers: string[]): Promise<Sheet> {
  const workbook = new ExcelJS.Workbook();
  let worksheet: ExcelJS.Worksheet;
  if (existsSync(filePath)) {
    await workbook.xlsx.readFile(filePath);
    worksheet = workbook.getWorksheet("Bot Log") ?? workbook.addWorksheet("Bot Log");
  } else {
    worksheet = workbook.addWorksheet("Bot Log");
    worksheet.columns = headers.map(() => ({ width: 22 }));
  }
  headers.forEach((h, i) => {
    worksheet.getRow(1).getCell(i + 1).value = h;
  });
  worksheet.getRow(1).font = { bold: true };
  return { workbook, worksheet, filePath };
}

export interface CloseLogEntry {
  atMs: number;
  runStartMs: number;
  cumulativeFeesUsd: number;
  // Sum of realized dpnl across closed positions - nets fees AND price
  // movement, so this is what should match the platform's own PNL figure.
  cumulativePnlUsd: number;
  initialBalanceUsd?: number;
  currentBalanceUsd?: number;
  cumulativeVolumeUsd: number;
}

/**
 * Costs = Fees - PNL. Perpl's dpnl (source of PNL) excludes fees - verified
 * against real deposit balance deltas - so this, not Fees+PNL, is what
 * actually matches how much the deposit shrinks. PNL is negative when
 * losing, so a loss ADDS to cost; a PNL gain SUBTRACTS from it.
 */
function costsUsd(entry: CloseLogEntry): number {
  return entry.cumulativeFeesUsd - entry.cumulativePnlUsd;
}

async function appendLiveRow(sheet: Sheet, entry: CloseLogEntry): Promise<void> {
  const feesPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativeFeesUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const pnlPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativePnlUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const costs = costsUsd(entry);
  const costsPerMillion = feesPerMillion - pnlPerMillion;

  sheet.worksheet.addRow([
    new Date(entry.atMs).toISOString(),
    Number(entry.cumulativeFeesUsd.toFixed(4)),
    entry.initialBalanceUsd != null ? Number(entry.initialBalanceUsd.toFixed(2)) : "n/a",
    entry.currentBalanceUsd != null ? Number(entry.currentBalanceUsd.toFixed(2)) : "n/a",
    Number(entry.cumulativeVolumeUsd.toFixed(2)),
    Number(feesPerMillion.toFixed(2)),
    formatDuration(entry.atMs - entry.runStartMs),
    Number(entry.cumulativePnlUsd.toFixed(4)),
    Number(costs.toFixed(4)),
    Number(pnlPerMillion.toFixed(2)),
    Number(costsPerMillion.toFixed(2)),
  ]);

  await sheet.workbook.xlsx.writeFile(sheet.filePath);
}

/** Cumulative-since-run-start figures shared by the per-run and 12h summary rows. */
function summaryRowValues(entry: CloseLogEntry, periodStartMs: number): (string | number)[] {
  const feesNeg = -entry.cumulativeFeesUsd;
  const feesPerMillionNeg =
    entry.cumulativeVolumeUsd > 0 ? -(entry.cumulativeFeesUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const pnlPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativePnlUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const netCosts = feesNeg + entry.cumulativePnlUsd;
  const netCostsPerMillion = feesPerMillionNeg + pnlPerMillion;
  const durationMs = entry.atMs - entry.runStartMs;
  const volumePerHour = durationMs > 0 ? entry.cumulativeVolumeUsd / (durationMs / 3_600_000) : 0;
  return [
    new Date(periodStartMs).toISOString(),
    new Date(entry.atMs).toISOString(),
    formatDuration(durationMs),
    entry.initialBalanceUsd != null ? Number(entry.initialBalanceUsd.toFixed(2)) : "n/a",
    entry.currentBalanceUsd != null ? Number(entry.currentBalanceUsd.toFixed(2)) : "n/a",
    Number(entry.cumulativeVolumeUsd.toFixed(2)),
    Number(feesNeg.toFixed(4)),
    Number(entry.cumulativePnlUsd.toFixed(4)),
    Number(netCosts.toFixed(4)),
    Number(feesPerMillionNeg.toFixed(2)),
    Number(pnlPerMillion.toFixed(2)),
    Number(netCostsPerMillion.toFixed(2)),
    Number(volumePerHour.toFixed(2)),
  ];
}

/**
 * Finds the row for this run (matched by its Run Start timestamp in column 1)
 * and overwrites it with the latest totals, or appends a new row if this is
 * the run's first close. Upserting (rather than appending every close) keeps
 * exactly one row per run so runs line up for easy side-by-side comparison,
 * and it's kept current in real time - not just written once at the end - so
 * an abrupt kill mid-run still leaves the latest known state on disk.
 */
async function upsertRunRow(sheet: Sheet, entry: CloseLogEntry): Promise<void> {
  const startIso = new Date(entry.runStartMs).toISOString();
  const values = summaryRowValues(entry, entry.runStartMs);

  let targetRow: ExcelJS.Row | undefined;
  for (let i = 2; i <= sheet.worksheet.rowCount; i++) {
    const row = sheet.worksheet.getRow(i);
    if (row.getCell(1).value === startIso) {
      targetRow = row;
      break;
    }
  }
  if (targetRow) {
    values.forEach((v, i) => {
      targetRow!.getCell(i + 1).value = v;
    });
  } else {
    sheet.worksheet.addRow(values);
  }

  await sheet.workbook.xlsx.writeFile(sheet.filePath);
}

/**
 * Always appends (never upserts) - each call is a new periodic snapshot, not a
 * running update of the same row, so the file builds a history of cumulative
 * totals sampled every ~12h across the run's lifetime.
 */
async function appendPeriodRow(sheet: Sheet, entry: CloseLogEntry, periodStartMs: number): Promise<void> {
  sheet.worksheet.addRow(summaryRowValues(entry, periodStartMs));
  await sheet.workbook.xlsx.writeFile(sheet.filePath);
}

let liveSheetPromise: Promise<Sheet> | undefined;
function getLiveSheet(): Promise<Sheet> {
  if (!liveSheetPromise) liveSheetPromise = openOrCreate(LIVE_XLSX_FILE, LIVE_HEADERS);
  return liveSheetPromise;
}

let summaryPerRunSheetPromise: Promise<Sheet> | undefined;
function getSummaryPerRunSheet(): Promise<Sheet> {
  if (!summaryPerRunSheetPromise) summaryPerRunSheetPromise = openOrCreate(SUMMARY_PER_RUN_FILE, RUN_SUMMARY_HEADERS);
  return summaryPerRunSheetPromise;
}

let summary12hSheetPromise: Promise<Sheet> | undefined;
function getSummary12hSheet(): Promise<Sheet> {
  if (!summary12hSheetPromise) summary12hSheetPromise = openOrCreate(SUMMARY_12H_FILE, SUMMARY_12H_HEADERS);
  return summary12hSheetPromise;
}

/** Appends a row to the live per-close ledger and upserts this run's row in the per-run summary sheet. */
export async function logCloseToXlsx(entry: CloseLogEntry): Promise<void> {
  const [live, runs] = await Promise.all([getLiveSheet(), getSummaryPerRunSheet()]);
  await Promise.all([appendLiveRow(live, entry), upsertRunRow(runs, entry)]);
}

/** Appends one cumulative-totals snapshot row to summary-12h.xlsx. periodStartMs marks the start of this ~12h window. */
export async function logPeriodSnapshotToXlsx(entry: CloseLogEntry, periodStartMs: number): Promise<void> {
  const sheet = await getSummary12hSheet();
  await appendPeriodRow(sheet, entry, periodStartMs);
}
