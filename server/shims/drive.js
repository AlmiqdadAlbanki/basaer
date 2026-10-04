'use strict';

// DriveApp / Drive (advanced v3) compatibility shim backed by SQLite metadata
// (table `files`) plus bytes on local disk (<filesDir>/<id>). Folders are pure
// metadata. IDs we mint look like `f_<32 hex>`; legacy Google Drive IDs that
// still appear in spreadsheet data are tolerated for folders (auto-created on
// first lookup) but not for files (their bytes never existed locally).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Blob } = require('./utilities.js');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function makeDriveShims({ storage, filesDir, baseUrl }) {
  const database = storage.db;
  const publicBaseUrl = baseUrl || '';

  function newFileId() {
    return 'f_' + crypto.randomUUID().replace(/-/g, '');
  }

  function contentPathFor(fileId) {
    return path.join(filesDir, fileId);
  }

  function writeContent(fileId, buffer) {
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(contentPathFor(fileId), buffer);
  }

  function readContent(fileId) {
    try {
      return fs.readFileSync(contentPathFor(fileId));
    } catch (_) {
      return Buffer.alloc(0);
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  const selectById = database.prepare('SELECT * FROM files WHERE id = ?');
  const insertRecord = database.prepare(
    `INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
     VALUES (@id, @name, @mime, @size, @parent_id, @is_folder, @is_public, @trashed, @created_at, @updated_at)`
  );

  function insertNewRecord(fields) {
    const timestamp = nowIso();
    const record = {
      id: fields.id || newFileId(),
      name: fields.name || '',
      mime: fields.mime || 'application/octet-stream',
      size: fields.size || 0,
      parent_id: fields.parent_id || null,
      is_folder: fields.is_folder ? 1 : 0,
      is_public: 0,
      trashed: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    insertRecord.run(record);
    return record;
  }

  function fileUrl(record) {
    return `${publicBaseUrl}/files/${record.id}/${encodeURIComponent(record.name)}`;
  }

  function folderUrl(record) {
    return `${publicBaseUrl}/files/folder/${record.id}`;
  }

  function makeIterator(items) {
    let position = 0;
    return {
      hasNext() { return position < items.length; },
      next() {
        if (position >= items.length) throw new Error('Iterator has no more items');
        return items[position++];
      },
    };
  }

  function listChildren(parentId, onlyFolders) {
    const folderClause = onlyFolders === undefined ? '' : ` AND is_folder = ${onlyFolders ? 1 : 0}`;
    return database
      .prepare(`SELECT * FROM files WHERE parent_id = ? AND trashed = 0${folderClause} ORDER BY created_at, rowid`)
      .all(parentId);
  }

  // ---- File / Folder wrappers -------------------------------------------

  class DriveFile {
    constructor(fileId) { this._id = fileId; }
    _record() {
      const record = selectById.get(this._id);
      if (!record) throw new Error('File not found: ' + this._id);
      return record;
    }
    getId() { return this._id; }
    getName() { return this._record().name; }
    setName(newName) {
      database.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(String(newName), nowIso(), this._id);
      return this;
    }
    getUrl() { return fileUrl(this._record()); }
    getDownloadUrl() { return fileUrl(this._record()) + '?download=1'; }
    getMimeType() { return this._record().mime; }
    getSize() { return this._record().size; }
    getDateCreated() { return new Date(this._record().created_at); }
    getLastUpdated() { return new Date(this._record().updated_at); }
    getBlob() {
      const record = this._record();
      return new Blob(readContent(this._id), record.mime, record.name);
    }
    getAs(mimeType) { return this.getBlob().getAs(mimeType); }
    setTrashed(isTrashed) {
      database.prepare('UPDATE files SET trashed = ?, updated_at = ? WHERE id = ?').run(isTrashed ? 1 : 0, nowIso(), this._id);
      return this;
    }
    isTrashed() { return this._record().trashed === 1; }
    getParents() {
      const parentId = this._record().parent_id;
      const parentRecord = parentId ? selectById.get(parentId) : null;
      return makeIterator(parentRecord ? [new DriveFolder(parentRecord.id)] : []);
    }
    makeCopy(...copyArguments) {
      let copyName;
      let destinationFolder;
      for (const argument of copyArguments) {
        if (typeof argument === 'string') copyName = argument;
        else if (argument) destinationFolder = argument;
      }
      const record = this._record();
      const copyRecord = insertNewRecord({
        name: copyName || 'Copy of ' + record.name,
        mime: record.mime,
        size: record.size,
        parent_id: destinationFolder ? destinationFolder.getId() : record.parent_id,
      });
      writeContent(copyRecord.id, readContent(this._id));
      return new DriveFile(copyRecord.id);
    }
    setSharing() { return this; }
  }

  class DriveFolder {
    constructor(folderId) { this._id = folderId; }
    _record() {
      const record = selectById.get(this._id);
      if (!record) throw new Error('Folder not found: ' + this._id);
      return record;
    }
    getId() { return this._id; }
    getName() { return this._record().name; }
    setName(newName) {
      database.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(String(newName), nowIso(), this._id);
      return this;
    }
    getUrl() { return folderUrl(this._record()); }
    setTrashed(isTrashed) {
      database.prepare('UPDATE files SET trashed = ?, updated_at = ? WHERE id = ?').run(isTrashed ? 1 : 0, nowIso(), this._id);
      return this;
    }
    getParents() {
      const parentId = this._record().parent_id;
      const parentRecord = parentId ? selectById.get(parentId) : null;
      return makeIterator(parentRecord ? [new DriveFolder(parentRecord.id)] : []);
    }
    createFile(blobOrName, content, mimeType) {
      let blob = blobOrName;
      if (typeof blobOrName === 'string') {
        // createFile(name, content, mimeType) form.
        blob = new Blob(content === undefined ? '' : content, mimeType || 'text/plain', blobOrName);
      }
      return new DriveFile(createFileRecord(this._id, blob));
    }
    createFolder(folderName) {
      const record = insertNewRecord({ name: folderName, mime: FOLDER_MIME, is_folder: true, parent_id: this._id });
      return new DriveFolder(record.id);
    }
    getFolders() {
      return makeIterator(listChildren(this._id, true).map((record) => new DriveFolder(record.id)));
    }
    getFiles() {
      return makeIterator(listChildren(this._id, false).map((record) => new DriveFile(record.id)));
    }
    getFoldersByName(folderName) {
      return makeIterator(
        listChildren(this._id, true).filter((record) => record.name === folderName).map((record) => new DriveFolder(record.id))
      );
    }
    getFilesByName(fileName) {
      return makeIterator(
        listChildren(this._id, false).filter((record) => record.name === fileName).map((record) => new DriveFile(record.id))
      );
    }
  }

  function createFileRecord(parentId, blob) {
    const buffer = blob._buffer();
    const record = insertNewRecord({
      name: blob.getName() || 'Untitled',
      mime: blob.getContentType(),
      size: buffer.length,
      parent_id: parentId,
    });
    writeContent(record.id, buffer);
    return record.id;
  }

  // ---- DriveApp ----------------------------------------------------------

  const DriveApp = {
    getFileById(fileId) {
      const record = selectById.get(String(fileId));
      if (!record || record.is_folder) {
        throw new Error(
          'File not found: ' + fileId +
          ' (legacy Google Drive files do not exist locally; register a .docx/.pptx stand-in for a template id with tools/register-template.js)'
        );
      }
      return new DriveFile(record.id);
    },
    getFolderById(folderId) {
      const id = String(folderId);
      const record = selectById.get(id);
      if (record) {
        if (!record.is_folder) throw new Error('Folder not found: ' + id);
        return new DriveFolder(id);
      }
      // Legacy Google Drive folder id referenced by existing sheet data: make it exist locally.
      insertNewRecord({ id, name: 'Legacy folder ' + id, mime: FOLDER_MIME, is_folder: true });
      return new DriveFolder(id);
    },
    getRootFolder() {
      const existing = selectById.get('root');
      if (!existing) insertNewRecord({ id: 'root', name: 'My Drive', mime: FOLDER_MIME, is_folder: true });
      return new DriveFolder('root');
    },
    createFile(blobOrName, content, mimeType) {
      return DriveApp.getRootFolder().createFile(blobOrName, content, mimeType);
    },
    createFolder(folderName) {
      return DriveApp.getRootFolder().createFolder(folderName);
    },
    Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT', COMMENT: 'COMMENT', OWNER: 'OWNER', NONE: 'NONE' },
  };

  // ---- Drive advanced service -------------------------------------------

  function toDriveResource(record) {
    const resource = {
      id: record.id,
      name: record.name,
      title: record.name,
      mimeType: record.mime,
      parents: record.parent_id ? [record.parent_id] : [],
      webViewLink: record.is_folder ? folderUrl(record) : fileUrl(record),
      iconLink: '',
      modifiedTime: record.updated_at,
      createdTime: record.created_at,
      trashed: record.trashed === 1,
    };
    if (!record.is_folder) {
      resource.webContentLink = fileUrl(record) + '?download=1';
      resource.size = String(record.size);
      if (/^image\//.test(record.mime)) resource.thumbnailLink = fileUrl(record);
    }
    return resource;
  }

  // Split on top-level " and " (ignoring any that sit inside quotes).
  function splitQueryClauses(queryText) {
    return queryText.split(/\s+and\s+(?=(?:[^']*'[^']*')*[^']*$)/i).map((clause) => clause.trim()).filter(Boolean);
  }

  function parseQuery(queryText) {
    const conditions = [];
    for (const clause of splitQueryClauses(queryText || '')) {
      let match;
      if ((match = /^'([^']*)'\s+in\s+parents$/i.exec(clause))) {
        const parentId = match[1];
        conditions.push((record) => record.parent_id === parentId);
      } else if ((match = /^trashed\s*=\s*(true|false)$/i.exec(clause))) {
        const wantTrashed = match[1].toLowerCase() === 'true';
        conditions.push((record) => (record.trashed === 1) === wantTrashed);
      } else if ((match = /^mimeType\s*(=|!=)\s*'([^']*)'$/.exec(clause))) {
        const isEqual = match[1] === '=';
        const mimeValue = match[2];
        conditions.push((record) => (record.mime === mimeValue) === isEqual);
      } else if ((match = /^name\s+contains\s+'((?:[^'\\]|\\.)*)'$/i.exec(clause))) {
        const needle = match[1].replace(/\\(.)/g, '$1').toLowerCase();
        conditions.push((record) => record.name.toLowerCase().includes(needle));
      } else if ((match = /^name\s*=\s*'((?:[^'\\]|\\.)*)'$/i.exec(clause))) {
        const exactName = match[1].replace(/\\(.)/g, '$1');
        conditions.push((record) => record.name === exactName);
      } else {
        throw new Error('Drive.Files.list: unsupported query clause: ' + clause);
      }
    }
    return conditions;
  }

  function sortRecords(records, orderBy) {
    const keys = String(orderBy || '').split(',').map((key) => key.trim()).filter(Boolean);
    const compareNames = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    return records.slice().sort((left, right) => {
      for (const key of keys) {
        let result = 0;
        if (key === 'folder') result = right.is_folder - left.is_folder;
        else if (key === 'name' || key === 'name_natural') result = compareNames(left, right);
        else if (key === 'modifiedTime') result = left.updated_at.localeCompare(right.updated_at);
        else if (key === 'modifiedTime desc') result = right.updated_at.localeCompare(left.updated_at);
        else if (key === 'createdTime') result = left.created_at.localeCompare(right.created_at);
        if (result !== 0) return result;
      }
      return 0;
    });
  }

  function requireRecord(fileId) {
    const record = selectById.get(String(fileId));
    if (!record) throw new Error('File not found: ' + fileId);
    return record;
  }

  const Drive = {
    Files: {
      get(fileId) {
        return toDriveResource(requireRecord(fileId));
      },
      list(options) {
        const conditions = parseQuery((options || {}).q);
        const matches = database.prepare('SELECT * FROM files').all().filter((record) => conditions.every((test) => test(record)));
        const sorted = sortRecords(matches, (options || {}).orderBy);
        const pageSize = (options && options.pageSize) || 100;
        const startIndex = options && options.pageToken ? Number(options.pageToken) : 0;
        const page = sorted.slice(startIndex, startIndex + pageSize);
        const result = { files: page.map(toDriveResource) };
        if (startIndex + pageSize < sorted.length) result.nextPageToken = String(startIndex + pageSize);
        return result;
      },
      update(resource, fileId, mediaBlob) {
        const record = requireRecord(fileId);
        const newName = resource && (resource.name || resource.title);
        const newMime = (resource && resource.mimeType) || (mediaBlob && mediaBlob.getContentType()) || record.mime;
        let newSize = record.size;
        if (mediaBlob) {
          const buffer = mediaBlob._buffer();
          writeContent(record.id, buffer);
          newSize = buffer.length;
        }
        database
          .prepare('UPDATE files SET name = ?, mime = ?, size = ?, updated_at = ? WHERE id = ?')
          .run(newName || record.name, newMime, newSize, nowIso(), record.id);
        return toDriveResource(selectById.get(record.id));
      },
      copy(resource, fileId) {
        const record = requireRecord(fileId);
        const parents = (resource && resource.parents) || [];
        const copyRecord = insertNewRecord({
          name: (resource && (resource.name || resource.title)) || 'Copy of ' + record.name,
          mime: record.mime,
          size: record.size,
          parent_id: parents[0] || record.parent_id,
        });
        writeContent(copyRecord.id, readContent(record.id));
        return toDriveResource(copyRecord);
      },
      create(resource, mediaBlob) {
        const parents = (resource && resource.parents) || [];
        const resourceName = resource && (resource.name || resource.title);
        const isFolder = !!resource && resource.mimeType === FOLDER_MIME;
        const record = insertNewRecord({
          name: resourceName || (mediaBlob && mediaBlob.getName()) || 'Untitled',
          mime: isFolder ? FOLDER_MIME : (resource && resource.mimeType) || (mediaBlob && mediaBlob.getContentType()) || 'application/octet-stream',
          size: mediaBlob ? mediaBlob._buffer().length : 0,
          parent_id: parents[0] || null,
          is_folder: isFolder,
        });
        if (!isFolder) writeContent(record.id, mediaBlob ? mediaBlob._buffer() : Buffer.alloc(0));
        return toDriveResource(record);
      },
    },
    Permissions: {
      create(resource, fileId) {
        const record = requireRecord(fileId);
        if (resource && resource.type === 'anyone') {
          database.prepare('UPDATE files SET is_public = 1 WHERE id = ?').run(record.id);
        }
        return { id: 'anyoneWithLink', type: (resource && resource.type) || 'anyone', role: (resource && resource.role) || 'reader' };
      },
      list(fileId) {
        const record = requireRecord(fileId);
        const permissions = [];
        if (record.is_public) permissions.push({ id: 'anyoneWithLink', type: 'anyone', role: 'reader' });
        return { permissions };
      },
      update(resource) {
        return resource;
      },
    },
  };

  // ---- Host-side internals ----------------------------------------------
  // Shared with the DocumentApp/SlidesApp shims and tools/register-template.js
  // so the file store has a single implementation.

  const internals = {
    getRecord(fileId) {
      return selectById.get(String(fileId)) || null;
    },
    readContent(fileId) {
      return readContent(String(fileId));
    },
    // Overwrite a file's bytes in place, keeping its id, name and mime.
    replaceContent(fileId, buffer) {
      const record = requireRecord(fileId);
      writeContent(record.id, buffer);
      database.prepare('UPDATE files SET size = ?, updated_at = ? WHERE id = ?').run(buffer.length, nowIso(), record.id);
    },
    renameFile(fileId, newName) {
      database.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(String(newName), nowIso(), String(fileId));
    },
    // Insert, or replace, a file record under an exact id (used to register
    // local stand-ins for legacy Google Drive template ids).
    registerFile({ id, name, mime, buffer, parentId }) {
      database.prepare('DELETE FROM files WHERE id = ?').run(String(id));
      const record = insertNewRecord({ id: String(id), name, mime, size: buffer.length, parent_id: parentId || null });
      writeContent(record.id, buffer);
      return record;
    },
  };

  return { DriveApp, Drive, internals };
}

module.exports = { makeDriveShims, FOLDER_MIME };
