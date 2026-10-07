'use strict';
const fs = require('fs');

/**
 * Write JSON so a crash or power cut mid-write can never leave a half-written
 * (unreadable) file: write a temp file beside it, then rename it over the
 * original. Falls back to a direct write if Windows refuses the rename because
 * another process has the file open at that instant.
 */
function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') fs.writeFileSync(file, text);
    else throw e;
  }
}

module.exports = { writeJsonAtomic };
