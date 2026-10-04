/**
 * ترحيل أرشيف ملفات الطلاب من حساب Google شخصي إلى Shared Drive تابع للمؤسسة.
 *
 * هذه أداة صيانة يدوية فقط، وليست جزءًا من واجهة الموقع. جميع الدوال العامة هنا تنتهي
 * بشرطة سفلية حتى لا تكون قابلة للاستدعاء من google.script.run في تطبيق الويب العام.
 *
 * الضمانات المقصودة:
 * - لا تنقل الملفات الأصلية ولا تحذفها ولا تغيّر صلاحياتها.
 * - تنسخ المجلدات والملفات إلى Shared Drive وتحتفظ بخريطة oldId -> newId في Google Sheet.
 * - آمنة لإعادة التشغيل: كل عنصر منسوخ يحمل appProperties بمعرّف مصدره، فلا تُنشأ نسخة ثانية
 *   إذا انقطع التنفيذ ثم استُكمل.
 * - تعمل على دفعات وتُكمل نفسها عبر Trigger لأن الأرشيف أكبر من حد تنفيذ Apps Script الواحد.
 * - تجعل بطاقات الطلاب والشهادات فقط (idCard-/BAS-) متاحة للعرض عبر الرابط، ولا تجعل بقية
 *   ملفات الطلاب الخاصة عامة.
 *
 * المتطلبات قبل التشغيل:
 * 1) مشاركة مجلد المصدر مع admin@basaerbh.com (قارئ على الأقل؛ محرر أفضل للصيانة).
 * 2) أن يكون admin@basaerbh.com مديرًا في Shared Drive الهدف.
 * 3) تشغيل startDriveOwnershipMigration_ يدويًا من محرر Apps Script بالحساب المؤسسي.
 */

var DRIVE_OWNERSHIP_MIGRATION_ = {
  sourceRootId: '1PexT7pwgJdaBUncuykBh6kYDAzzhyNYs',
  targetSharedDriveRootId: '0ACcgrHngtmF1Uk9PVA',
  expectedExecutorEmail: 'admin@basaerbh.com',
  targetFolderName: 'perArchive',
  migrationKey: 'basaer-perArchive-v1',
  statePrefix: 'driveOwnershipMigrationV1_',
  workerFunction: 'continueDriveOwnershipMigration_',
  pageSize: 20,
  maxRunMs: 4.5 * 60 * 1000
};

var DRIVE_MIGRATION_FOLDER_HEADERS_ = [
  'sourceId', 'targetId', 'path', 'status', 'pageToken',
  'copiedFiles', 'createdFolders', 'errors', 'lastMessage', 'updatedAt'
];

var DRIVE_MIGRATION_FILE_HEADERS_ = [
  'sourceId', 'targetId', 'name', 'mimeType', 'sourceParentId', 'targetParentId',
  'path', 'status', 'publicSharing', 'error', 'createdAt'
];

/**
 * نقطة البدء الوحيدة المطلوبة من المستخدم. آمنة عند تكرارها: إن كان ترحيل قائمًا تستكمله،
 * وإن كان منتهيًا تعيد ملخصه ولا تبدأ نسخة جديدة.
 */
function startDriveOwnershipMigration_() {
  migrationRequireInstitutionalExecutor_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var props = PropertiesService.getScriptProperties();
    var existingLogId = props.getProperty(migrationPropKey_('logSpreadsheetId'));
    var existingStatus = props.getProperty(migrationPropKey_('status'));

    if (existingLogId) {
      if (existingStatus === 'copy_complete' || existingStatus === 'copy_complete_with_errors') {
        var finished = getDriveOwnershipMigrationStatus_();
        Logger.log(JSON.stringify(finished, null, 2));
        return finished;
      }
      props.setProperty(migrationPropKey_('status'), 'running');
      props.setProperty(migrationPropKey_('workerFailures'), '0');
      ensureDriveMigrationWorkerTrigger_();
      return continueDriveOwnershipMigration_();
    }

    var source = Drive.Files.get(DRIVE_OWNERSHIP_MIGRATION_.sourceRootId, {
      supportsAllDrives: true,
      fields: 'id,name,mimeType,trashed'
    });
    if (source.trashed || source.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('مجلد المصدر غير صالح أو موجود في سلة المهملات.');
    }

    // جذر Shared Drive ليس مجلد My Drive عاديًا؛ Drives.get هو فحص الصلاحية الأدق له.
    var targetDrive = Drive.Drives.get(DRIVE_OWNERSHIP_MIGRATION_.targetSharedDriveRootId, {
      fields: 'id,name'
    });

    var targetRoot = migrationFindOrCreateFolder_(
      DRIVE_OWNERSHIP_MIGRATION_.sourceRootId,
      DRIVE_OWNERSHIP_MIGRATION_.targetSharedDriveRootId,
      DRIVE_OWNERSHIP_MIGRATION_.targetFolderName
    );
    var logId = migrationFindOrCreateLogSpreadsheet_(targetRoot.id);
    migrationInitializeLog_(logId, source, targetDrive, targetRoot);

    props.setProperties((function () {
      var state = {};
      state[migrationPropKey_('status')] = 'running';
      state[migrationPropKey_('logSpreadsheetId')] = logId;
      state[migrationPropKey_('targetRootId')] = targetRoot.id;
      state[migrationPropKey_('sourceRootId')] = source.id;
      state[migrationPropKey_('startedAt')] = new Date().toISOString();
      state[migrationPropKey_('copiedFiles')] = '0';
      state[migrationPropKey_('createdFolders')] = '0';
      state[migrationPropKey_('errors')] = '0';
      state[migrationPropKey_('workerFailures')] = '0';
      return state;
    })(), false);

    ensureDriveMigrationWorkerTrigger_();
  } finally {
    lock.releaseLock();
  }

  return continueDriveOwnershipMigration_();
}

/**
 * عامل الاستكمال. يُشغّل تلقائيًا بالـTrigger، ويمكن تشغيله يدويًا أيضًا عند الحاجة.
 */
function continueDriveOwnershipMigration_() {
  migrationRequireInstitutionalExecutor_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, status: 'already_running' };

  var startedAt = Date.now();
  try {
    deleteDriveMigrationWorkerTriggers_();
    var props = PropertiesService.getScriptProperties();
    var logId = props.getProperty(migrationPropKey_('logSpreadsheetId'));
    if (!logId) throw new Error('لم يبدأ الترحيل بعد. شغّل startDriveOwnershipMigration_ أولًا.');

    var status = props.getProperty(migrationPropKey_('status')) || 'running';
    if (status === 'cancelled' || status.indexOf('copy_complete') === 0) {
      return getDriveOwnershipMigrationStatus_();
    }

    var logBook = SpreadsheetApp.openById(logId);
    var foldersSheet = logBook.getSheetByName('folders');
    var filesSheet = logBook.getSheetByName('files');
    var folderValues = foldersSheet.getDataRange().getValues();
    var knownFolders = {};
    var rowBySourceId = {};
    for (var i = 1; i < folderValues.length; i++) {
      var sourceId = String(folderValues[i][0] || '');
      if (!sourceId) continue;
      knownFolders[sourceId] = true;
      rowBySourceId[sourceId] = i + 1;
    }

    while (Date.now() - startedAt < DRIVE_OWNERSHIP_MIGRATION_.maxRunMs) {
      var pending = migrationFindPendingFolder_(foldersSheet);
      if (!pending) {
        migrationFinishCopyPhase_(props, logBook);
        return getDriveOwnershipMigrationStatus_();
      }

      var folderRow = pending.row;
      var sourceFolderId = pending.values[0];
      var targetFolderId = pending.values[1];
      var folderPath = pending.values[2] || '/';
      var pageToken = pending.values[4] || null;

      foldersSheet.getRange(folderRow, 4).setValue('in_progress');
      foldersSheet.getRange(folderRow, 10).setValue(new Date());

      var response = Drive.Files.list({
        q: "'" + migrationEscapeQuery_(sourceFolderId) + "' in parents and trashed = false",
        pageSize: DRIVE_OWNERSHIP_MIGRATION_.pageSize,
        pageToken: pageToken || undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: 'nextPageToken,files(id,name,mimeType,size,shortcutDetails)'
      });

      var fileLogRows = [];
      var childFolderRows = [];
      var pageCopied = 0;
      var pageFolders = 0;
      var pageErrors = 0;

      (response.files || []).forEach(function (item) {
        var itemPath = (folderPath === '/' ? '' : folderPath) + '/' + item.name;
        try {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            var targetChild = migrationFindOrCreateFolder_(item.id, targetFolderId, item.name);
            if (!knownFolders[item.id]) {
              childFolderRows.push([item.id, targetChild.id, itemPath, 'pending', '', 0, 0, 0, '', new Date()]);
              knownFolders[item.id] = true;
            }
            pageFolders++;
            return;
          }

          if (item.mimeType === 'application/vnd.google-apps.shortcut') {
            throw new Error('الاختصارات لا تُنسخ تلقائيًا؛ راجع هدف الاختصار يدويًا.');
          }

          var targetFile = migrationFindOrCopyFile_(item, targetFolderId);
          var sharingResult = migrationSetIssuedFilePublic_(targetFile.id, item.name);
          var fileStatus = sharingResult.indexOf('failed:') === 0 ? 'copied_sharing_failed' : 'copied';
          var fileError = fileStatus === 'copied_sharing_failed' ? sharingResult.substring(7) : '';
          if (fileError) pageErrors++;

          fileLogRows.push([
            item.id, targetFile.id, item.name, item.mimeType, sourceFolderId, targetFolderId,
            itemPath, fileStatus, sharingResult, fileError, new Date()
          ]);
          pageCopied++;
        } catch (err) {
          pageErrors++;
          fileLogRows.push([
            item.id, '', item.name, item.mimeType, sourceFolderId, targetFolderId,
            itemPath, 'failed', 'not_attempted', String(err && err.message || err), new Date()
          ]);
        }
      });

      migrationAppendRows_(filesSheet, fileLogRows);
      migrationAppendRows_(foldersSheet, childFolderRows);

      var current = foldersSheet.getRange(folderRow, 1, 1, DRIVE_MIGRATION_FOLDER_HEADERS_.length).getValues()[0];
      current[5] = (+current[5] || 0) + pageCopied;
      current[6] = (+current[6] || 0) + pageFolders;
      current[7] = (+current[7] || 0) + pageErrors;
      current[8] = pageErrors ? 'اكتملت الصفحة مع أخطاء؛ راجع تبويب files' : 'اكتملت الصفحة';
      current[9] = new Date();

      if (response.nextPageToken) {
        current[3] = 'in_progress';
        current[4] = response.nextPageToken;
      } else {
        current[3] = pageErrors ? 'done_with_errors' : 'done';
        current[4] = '';
      }
      foldersSheet.getRange(folderRow, 1, 1, current.length).setValues([current]);

      migrationIncrementCounter_(props, 'copiedFiles', pageCopied);
      migrationIncrementCounter_(props, 'createdFolders', pageFolders);
      migrationIncrementCounter_(props, 'errors', pageErrors);
      props.setProperty(migrationPropKey_('workerFailures'), '0');
      SpreadsheetApp.flush();
    }

    ensureDriveMigrationWorkerTrigger_();
    props.setProperty(migrationPropKey_('lastRunAt'), new Date().toISOString());
    return getDriveOwnershipMigrationStatus_();
  } catch (err) {
    var errorProps = PropertiesService.getScriptProperties();
    var failureCount = +(errorProps.getProperty(migrationPropKey_('workerFailures')) || 0) + 1;
    errorProps.setProperty(migrationPropKey_('workerFailures'), String(failureCount));
    errorProps.setProperty(migrationPropKey_('lastError'), String(err && err.stack || err));
    // لا نترك خطأ صلاحيات دائمًا يولّد Trigger جديدًا إلى ما لا نهاية. ثلاث محاولات تكفي
    // للأخطاء العابرة؛ بعدها يتوقف بأمان ويمكن استئنافه يدويًا بتشغيل start... ثانيةً.
    if (failureCount < 3) {
      ensureDriveMigrationWorkerTrigger_();
    } else {
      errorProps.setProperty(migrationPropKey_('status'), 'paused_error');
      deleteDriveMigrationWorkerTriggers_();
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * ملخص آمن بلا تعديل. يظهر أيضًا في Execution log عند تشغيله يدويًا.
 */
function getDriveOwnershipMigrationStatus_() {
  migrationRequireInstitutionalExecutor_();
  var props = PropertiesService.getScriptProperties();
  var result = {
    status: props.getProperty(migrationPropKey_('status')) || 'not_started',
    sourceRootId: props.getProperty(migrationPropKey_('sourceRootId')) || DRIVE_OWNERSHIP_MIGRATION_.sourceRootId,
    targetRootId: props.getProperty(migrationPropKey_('targetRootId')) || '',
    logSpreadsheetId: props.getProperty(migrationPropKey_('logSpreadsheetId')) || '',
    copiedFiles: +(props.getProperty(migrationPropKey_('copiedFiles')) || 0),
    createdFolders: +(props.getProperty(migrationPropKey_('createdFolders')) || 0),
    errors: +(props.getProperty(migrationPropKey_('errors')) || 0),
    startedAt: props.getProperty(migrationPropKey_('startedAt')) || '',
    finishedAt: props.getProperty(migrationPropKey_('finishedAt')) || '',
    lastRunAt: props.getProperty(migrationPropKey_('lastRunAt')) || '',
    lastError: props.getProperty(migrationPropKey_('lastError')) || ''
  };
  result.targetRootUrl = result.targetRootId ? 'https://drive.google.com/drive/folders/' + result.targetRootId : '';
  result.logSpreadsheetUrl = result.logSpreadsheetId ? 'https://docs.google.com/spreadsheets/d/' + result.logSpreadsheetId + '/edit' : '';
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * يوقف الاستكمال التلقائي فقط. لا يحذف الملفات المنسوخة ولا الأصلية ولا سجل الترحيل.
 */
function cancelDriveOwnershipMigration_() {
  migrationRequireInstitutionalExecutor_();
  deleteDriveMigrationWorkerTriggers_();
  PropertiesService.getScriptProperties().setProperty(migrationPropKey_('status'), 'cancelled');
  return getDriveOwnershipMigrationStatus_();
}

function migrationRequireInstitutionalExecutor_() {
  var actual = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var expected = DRIVE_OWNERSHIP_MIGRATION_.expectedExecutorEmail.toLowerCase();
  if (actual !== expected) {
    throw new Error('أوقف الترحيل: يجب تشغيله يدويًا من الحساب ' + expected + '، والحساب الحالي هو ' + (actual || 'غير معروف'));
  }
}

function migrationPropKey_(suffix) {
  return DRIVE_OWNERSHIP_MIGRATION_.statePrefix + suffix;
}

function migrationEscapeQuery_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function migrationFindOrCreateFolder_(sourceId, targetParentId, name) {
  var existing = migrationFindTargetBySourceId_(sourceId, targetParentId, 'application/vnd.google-apps.folder');
  if (existing) return existing;

  return Drive.Files.create({
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [targetParentId],
    appProperties: {
      basaerMigration: DRIVE_OWNERSHIP_MIGRATION_.migrationKey,
      basaerSourceId: sourceId
    }
  }, null, {
    supportsAllDrives: true,
    fields: 'id,name,mimeType,webViewLink'
  });
}

function migrationFindOrCopyFile_(sourceFile, targetParentId) {
  var existing = migrationFindTargetBySourceId_(sourceFile.id, targetParentId, null);
  if (existing) return existing;

  return Drive.Files.copy({
    name: sourceFile.name,
    parents: [targetParentId],
    appProperties: {
      basaerMigration: DRIVE_OWNERSHIP_MIGRATION_.migrationKey,
      basaerSourceId: sourceFile.id
    }
  }, sourceFile.id, {
    supportsAllDrives: true,
    fields: 'id,name,mimeType,webViewLink'
  });
}

function migrationFindTargetBySourceId_(sourceId, targetParentId, mimeType) {
  var q = "'" + migrationEscapeQuery_(targetParentId) + "' in parents and trashed = false" +
    " and appProperties has { key='basaerSourceId' and value='" + migrationEscapeQuery_(sourceId) + "' }";
  if (mimeType) q += " and mimeType='" + migrationEscapeQuery_(mimeType) + "'";

  var response = Drive.Files.list({
    q: q,
    corpora: 'drive',
    driveId: DRIVE_OWNERSHIP_MIGRATION_.targetSharedDriveRootId,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 2,
    fields: 'files(id,name,mimeType,webViewLink)'
  });
  return response.files && response.files.length ? response.files[0] : null;
}

function migrationFindOrCreateLogSpreadsheet_(targetRootId) {
  var marker = DRIVE_OWNERSHIP_MIGRATION_.migrationKey + '-log';
  var existing = migrationFindTargetBySourceId_(marker, targetRootId, 'application/vnd.google-apps.spreadsheet');
  if (existing) return existing.id;

  var file = Drive.Files.create({
    name: 'سجل ترحيل ملفات بصائر - ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: [targetRootId],
    appProperties: {
      basaerMigration: DRIVE_OWNERSHIP_MIGRATION_.migrationKey,
      basaerSourceId: marker
    }
  }, null, {
    supportsAllDrives: true,
    fields: 'id'
  });
  return file.id;
}

function migrationInitializeLog_(logId, source, targetDrive, targetRoot) {
  var ss = SpreadsheetApp.openById(logId);
  var folders = ss.getSheetByName('folders') || ss.insertSheet('folders');
  var files = ss.getSheetByName('files') || ss.insertSheet('files');
  var state = ss.getSheetByName('state') || ss.insertSheet('state');

  if (folders.getLastRow() === 0) {
    folders.appendRow(DRIVE_MIGRATION_FOLDER_HEADERS_);
    folders.appendRow([source.id, targetRoot.id, '/', 'pending', '', 0, 0, 0, '', new Date()]);
    folders.setFrozenRows(1);
  }
  if (files.getLastRow() === 0) {
    files.appendRow(DRIVE_MIGRATION_FILE_HEADERS_);
    files.setFrozenRows(1);
  }
  if (state.getLastRow() === 0) {
    state.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    state.getRange(2, 1, 6, 2).setValues([
      ['sourceRootId', source.id],
      ['sourceName', source.name],
      ['targetSharedDriveId', targetDrive.id],
      ['targetSharedDriveName', targetDrive.name],
      ['targetRootId', targetRoot.id],
      ['createdAt', new Date()]
    ]);
    state.setFrozenRows(1);
  }

  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('ورقة1');
  if (defaultSheet && ss.getSheets().length > 3) ss.deleteSheet(defaultSheet);
}

function migrationFindPendingFolder_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, DRIVE_MIGRATION_FOLDER_HEADERS_.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var status = String(values[i][3] || '');
    if (status === 'pending' || status === 'in_progress') {
      return { row: i + 2, values: values[i] };
    }
  }
  return null;
}

function migrationAppendRows_(sheet, rows) {
  if (!rows || !rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function migrationSetIssuedFilePublic_(fileId, fileName) {
  if (!/^(BAS-|idCard-)/.test(String(fileName || ''))) return 'not_applicable';
  try {
    var permissions = Drive.Permissions.list(fileId, {
      supportsAllDrives: true,
      fields: 'permissions(id,type,role)'
    }).permissions || [];
    if (permissions.some(function (p) { return p.type === 'anyone' && p.role === 'reader'; })) {
      return 'already_public';
    }
    Drive.Permissions.create({ type: 'anyone', role: 'reader' }, fileId, {
      supportsAllDrives: true,
      fields: 'id'
    });
    return 'created';
  } catch (err) {
    return 'failed:' + String(err && err.message || err);
  }
}

function migrationIncrementCounter_(props, suffix, amount) {
  if (!amount) return;
  var key = migrationPropKey_(suffix);
  props.setProperty(key, String(+(props.getProperty(key) || 0) + amount));
}

function migrationFinishCopyPhase_(props, logBook) {
  var errors = +(props.getProperty(migrationPropKey_('errors')) || 0);
  var status = errors ? 'copy_complete_with_errors' : 'copy_complete';
  props.setProperty(migrationPropKey_('status'), status);
  props.setProperty(migrationPropKey_('finishedAt'), new Date().toISOString());
  props.setProperty(migrationPropKey_('lastRunAt'), new Date().toISOString());
  deleteDriveMigrationWorkerTriggers_();

  var state = logBook.getSheetByName('state');
  state.appendRow(['copyStatus', status]);
  state.appendRow(['copyFinishedAt', new Date()]);
  state.appendRow(['nextStep', 'راجع الأخطاء ثم حدّث روابط الشيتات وperArchiveID بعد اعتماد النسخة المنسوخة.']);
}

function ensureDriveMigrationWorkerTrigger_() {
  var handler = DRIVE_OWNERSHIP_MIGRATION_.workerFunction;
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) ScriptApp.newTrigger(handler).timeBased().after(60 * 1000).create();
}

function deleteDriveMigrationWorkerTriggers_() {
  var handler = DRIVE_OWNERSHIP_MIGRATION_.workerFunction;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
}
