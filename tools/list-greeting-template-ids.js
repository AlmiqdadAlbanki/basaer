"use strict";

// Prints the templateId of every row in refID / greetingTemplates, one per line
// (the column exportNewCard in gas/dataPost.js reads). Used by
// tools/google-exports.sh discover. A pasted Slides url is reduced to its id.
//
//   node tools/list-greeting-template-ids.js [--db <path>]

const path = require("path");
const { Storage } = require("../server/storage.js");
const { IDS, DEFAULT_DB, parseArgs } = require("./xlsx-common.js");

function extractDriveId(value) {
  const text = String(value || "").trim();
  const fromUrl = text.match(/\/d\/([A-Za-z0-9_-]+)/) || text.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return fromUrl ? fromUrl[1] : text;
}

function listGreetingTemplateIds(storage) {
  if (!storage.sheetExists(IDS.refID, "greetingTemplates")) return [];
  const grid = storage.loadGrid(IDS.refID, "greetingTemplates");
  if (!grid.length) return [];
  const column = grid[0].map((h) => String(h).trim()).indexOf("templateId");
  if (column < 0) return [];
  const found = grid.slice(1).map((row) => extractDriveId(row[column])).filter((id) => /^[A-Za-z0-9_-]{20,}$/.test(id));
  return [...new Set(found)];
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const storage = new Storage(path.resolve(args.db || process.env.BASAER_DB || DEFAULT_DB));
  try {
    for (const id of listGreetingTemplateIds(storage)) console.log(id);
  } finally {
    storage.close();
  }
}

module.exports = { listGreetingTemplateIds, extractDriveId };
