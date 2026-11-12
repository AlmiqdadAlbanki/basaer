'use strict';

// Utilities.formatDate: the time-zone offset tokens and quoted literals, as Java's
// SimpleDateFormat prints them. The exam screens build their date boundaries from 'Z'
// (gas/dataGet.js utcOffsetString_); without it every exam stayed "draft".

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const { Utilities } = require('./utilities.js');

const formatDate = Utilities.formatDate;

test("'Z' and 'XXX' print the zone's offset at that instant", () => {
  const instant = new Date('2026-11-12T10:00:00Z');
  assert.strictEqual(formatDate(instant, 'Asia/Qatar', 'Z'), '+0300');
  assert.strictEqual(formatDate(instant, 'Asia/Dubai', 'Z'), '+0400');
  assert.strictEqual(formatDate(instant, 'Etc/UTC', 'Z'), '+0000');
  assert.strictEqual(formatDate(instant, 'America/New_York', 'Z'), '-0500');
  assert.strictEqual(formatDate(instant, 'Asia/Kolkata', 'XXX'), '+05:30');
  assert.strictEqual(formatDate(new Date('2026-07-01T10:00:00Z'), 'America/New_York', 'Z'), '-0400', 'daylight saving');
});

test('quoted text is literal, and two quotes are one quote', () => {
  const instant = new Date('2026-11-12T10:05:09Z');
  assert.strictEqual(formatDate(instant, 'Etc/UTC', "yyyyMMdd'T'HHmmss'Z'"), '20261112T100509Z');
  assert.strictEqual(formatDate(instant, 'Etc/UTC', "HH 'o''clock'"), "10 o'clock");
  assert.strictEqual(formatDate(instant, 'Asia/Qatar', 'yyyy-MM-dd HH:mm'), '2026-11-12 13:05', 'plain patterns unchanged');
});

test('the exam status the admin page shows: dates around now are "open", not "draft"', () => {
  // Run the real gas functions from dataGet.js with a stub spreadsheet in Asia/Qatar.
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'gas', 'dataGet.js'), 'utf8');
  const pick = (name) => {
    const start = source.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('not found: ' + name);
  };
  const context = {
    Utilities: { formatDate },
    SpreadsheetApp: { openById: () => ({ getSpreadsheetTimeZone: () => 'Asia/Qatar' }) },
    refID: 'ref', Date,
  };
  vm.runInNewContext(['examSheetTimeZone_', 'utcOffsetString_', 'computeExamStatusFromDates_'].map(pick).join('\n'), context);
  const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(context.computeExamStatusFromDates_(day(-1), '00:00', day(1), '23:59'), 'open');
  assert.strictEqual(context.computeExamStatusFromDates_(day(2), '00:00', day(3), '23:59'), 'scheduled');
  assert.strictEqual(context.computeExamStatusFromDates_(day(-3), '00:00', day(-2), '23:59'), 'closed');
  assert.strictEqual(context.computeExamStatusFromDates_('', '', '', ''), 'draft');
});
