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
const RUNS_SUMMARY_FILE = `${LOG_DIR}runs-summary${LABEL_SUFFIX}.xlsx`;

const LIVE_HEADERS = [
  "Timestamp",
  "Fees Spent ($, cumulative)",
  "PNL ($, cumulative)",
  "Costs ($, cumulative)",
  "Initial Deposit ($)",
  "Current Deposit ($)",
  "Volume ($, cumulative)",
  "Fees per $1M Volume ($)",
  "PNL per $1M Volume ($)",
  "Costs per $1M Volume ($)",
  "Run Duration (H:MM:SS)",
];

const RUNS_HEADERS = [
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

/** Costs = Fees + PNL (dollar sum). PNL is negative when losing, so this shrinks the cost by however much PNL adds back on top of fees. */
function costsUsd(entry: CloseLogEntry): number {
  return entry.cumulativeFeesUsd + entry.cumulativePnlUsd;
}

async function appendLiveRow(sheet: Sheet, entry: CloseLogEntry): Promise<void> {
  const feesPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativeFeesUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const pnlPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativePnlUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const costs = costsUsd(entry);
  const costsPerMillion = feesPerMillion + pnlPerMillion;

  sheet.worksheet.addRow([
    new Date(entry.atMs).toISOString(),
    Number(entry.cumulativeFeesUsd.toFixed(4)),
    Number(entry.cumulativePnlUsd.toFixed(4)),
    Number(costs.toFixed(4)),
    entry.initialBalanceUsd != null ? Number(entry.initialBalanceUsd.toFixed(2)) : "n/a",
    entry.currentBalanceUsd != null ? Number(entry.currentBalanceUsd.toFixed(2)) : "n/a",
    Number(entry.cumulativeVolumeUsd.toFixed(2)),
    Number(feesPerMillion.toFixed(2)),
    Number(pnlPerMillion.toFixed(2)),
    Number(costsPerMillion.toFixed(2)),
    formatDuration(entry.atMs - entry.runStartMs),
  ]);

  await sheet.workbook.xlsx.writeFile(sheet.filePath);
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
  const feesPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativeFeesUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const pnlPerMillion =
    entry.cumulativeVolumeUsd > 0 ? (entry.cumulativePnlUsd / entry.cumulativeVolumeUsd) * 1e6 : 0;
  const costs = costsUsd(entry);
  const costsPerMillion = feesPerMillion + pnlPerMillion;
  const startIso = new Date(entry.runStartMs).toISOString();
  const values = [
    startIso,
    new Date(entry.atMs).toISOString(),
    formatDuration(entry.atMs - entry.runStartMs),
    entry.initialBalanceUsd != null ? Number(entry.initialBalanceUsd.toFixed(2)) : "n/a",
    entry.currentBalanceUsd != null ? Number(entry.currentBalanceUsd.toFixed(2)) : "n/a",
    Number(entry.cumulativeVolumeUsd.toFixed(2)),
    Number(entry.cumulativeFeesUsd.toFixed(4)),
    Number(entry.cumulativePnlUsd.toFixed(4)),
    Number(costs.toFixed(4)),
    Number(feesPerMillion.toFixed(2)),
    Number(pnlPerMillion.toFixed(2)),
    Number(costsPerMillion.toFixed(2)),
  ];

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

let liveSheetPromise: Promise<Sheet> | undefined;
function getLiveSheet(): Promise<Sheet> {
  if (!liveSheetPromise) liveSheetPromise = openOrCreate(LIVE_XLSX_FILE, LIVE_HEADERS);
  return liveSheetPromise;
}

let runsSummarySheetPromise: Promise<Sheet> | undefined;
function getRunsSummarySheet(): Promise<Sheet> {
  if (!runsSummarySheetPromise) runsSummarySheetPromise = openOrCreate(RUNS_SUMMARY_FILE, RUNS_HEADERS);
  return runsSummarySheetPromise;
}

/** Appends a row to the live per-close ledger and upserts this run's row in the all-runs comparison sheet. */
export async function logCloseToXlsx(entry: CloseLogEntry): Promise<void> {
  const [live, runs] = await Promise.all([getLiveSheet(), getRunsSummarySheet()]);
  await Promise.all([appendLiveRow(live, entry), upsertRunRow(runs, entry)]);
}
