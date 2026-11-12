'use strict';

// Columns that were live formulas in the Google Sheets and therefore cannot be stored:
// the export kept only the value they had at export time, frozen. Each one is
// recomputed here whenever the Sheets shim reads it, with the same rule the formula had.
//
// rules!H "check" (refID workbook) — whether a student may start the exam now:
//   =IF(ROW(B1:B28)=ROW(B1), "check",
//       IF(B1:B28="",, ((NOW() >= (C1:C28+D1:D28)) * (NOW() <= (E1:E28+F1:F28)))>0 ))
//   i.e. blank when the exam name is blank, otherwise TRUE while
//   start date + start time <= now <= end date + end time, in the spreadsheet's time zone.
//   An empty time adds nothing (the boundary is that day's midnight), exactly as in Sheets.
//   (The original formula only covered rows 2-28; every row is computed here, so an exam
//   added below row 28 is not silently unavailable to students.)
// Without this, `check` stayed at its export-time value (FALSE everywhere), and no exam
// was ever offered to students (getExams in gas/dataGet.js) although the admin page,
// which computes its status from the dates, said "متاح الآن".

const { Utilities } = require('./utilities.js');

// Wall-clock parts of a date-or-time cell in the sheet's zone, or null when unusable.
// A date cell may hold a Date (imported) or the text the app wrote ("2026-11-12");
// a time cell a Date (a 1899-12-30 time serial, imported) or text ("08:30").
function datePartOf_(cell, timeZone) {
  if (cell instanceof Date) {
    if (isNaN(cell.getTime())) return null;
    const [y, m, d] = Utilities.formatDate(cell, timeZone, 'yyyy-MM-dd').split('-').map(Number);
    return { y, m, d };
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(cell || '').trim());
  return match ? { y: +match[1], m: +match[2], d: +match[3] } : null;
}

function secondsOfDayOf_(cell, timeZone) {
  if (cell === '' || cell === null || cell === undefined) return 0;
  if (cell instanceof Date) {
    if (isNaN(cell.getTime())) return 0;
    const [h, mi, s] = Utilities.formatDate(cell, timeZone, 'HH:mm:ss').split(':').map(Number);
    return h * 3600 + mi * 60 + s;
  }
  if (typeof cell === 'number') return Math.round((cell % 1) * 86400); // a bare time serial
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(cell).trim());
  return match ? +match[1] * 3600 + +match[2] * 60 + +(match[3] || 0) : 0;
}

// The instant of (date + time of day) on the wall clock of timeZone, or null.
function boundaryInstant_(dateCell, timeCell, timeZone) {
  const day = datePartOf_(dateCell, timeZone);
  if (!day) return null;
  const seconds = secondsOfDayOf_(timeCell, timeZone);
  const wallClockAsUtc = Date.UTC(day.y, day.m - 1, day.d, 0, 0, seconds);
  // The zone's offset at that moment (two passes settle the rare DST-edge case).
  let instant = wallClockAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    const offset = Utilities.formatDate(new Date(instant), timeZone, 'Z'); // "+0300"
    const sign = offset[0] === '-' ? -1 : 1;
    const offsetMs = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(3, 5), 10)) * 60000;
    instant = wallClockAsUtc - offsetMs;
  }
  return instant;
}

function examCheck_(row, headers, timeZone, nowMs) {
  const cell = (name) => row[headers.indexOf(name)];
  if (cell('exam') === '' || cell('exam') === null || cell('exam') === undefined) return '';
  const start = boundaryInstant_(cell('start'), cell('startTime'), timeZone);
  const end = boundaryInstant_(cell('end'), cell('endTime'), timeZone);
  // An empty start date adds up to a moment in 1899 in Sheets (always passed); an empty
  // end date likewise (never reached): the same here.
  const afterStart = start === null ? true : nowMs >= start;
  const beforeEnd = end === null ? false : nowMs <= end;
  return afterStart && beforeEnd;
}

// sheet name -> { header -> compute(row, headers, timeZone, nowMs) }, for the refID workbook.
const COMPUTED_COLUMNS = {
  rules: { check: examCheck_ },
};
const REF_ID = '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo';

// For a sheet, the computed columns as [{ columnIndex (0-based), compute }], or null.
function computedColumnsFor(spreadsheetId, sheetName, headerRow) {
  if (spreadsheetId !== REF_ID || !COMPUTED_COLUMNS[sheetName] || !headerRow) return null;
  const columns = [];
  for (const [header, compute] of Object.entries(COMPUTED_COLUMNS[sheetName])) {
    const columnIndex = headerRow.indexOf(header);
    if (columnIndex >= 0) columns.push({ columnIndex, compute });
  }
  return columns.length ? columns : null;
}

module.exports = { computedColumnsFor, examCheck_, boundaryInstant_ };
