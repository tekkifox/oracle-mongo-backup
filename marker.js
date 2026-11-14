const fs = require('fs')
const path = require('path')

const MARKER_NAME = 'last-success'

function stateDir() {
  return process.env.STATE_DIR || '/state'
}

// Write the completion marker the host-side uptime check reads.
//
//   line 1: completion time as Unix epoch seconds
//   line 2: human summary, e.g. "collections=23 documents=37374 bytes=3611403"
//
// The write is atomic (temp file in the same directory, then rename) so the
// check never sees a partially written marker. A marker problem must never
// fail the backup: on any error this logs and returns { written: false }.
function writeSuccessMarker(summary, { dir = stateDir(), now = new Date(), log = console } = {}) {
  const target = path.join(dir, MARKER_NAME)
  // Same directory as the target, so rename(2) is atomic.
  const tmp = path.join(dir, `.${MARKER_NAME}.${process.pid}.${Date.now()}.tmp`)

  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory')
    fs.accessSync(dir, fs.constants.W_OK)
    fs.writeFileSync(tmp, `${Math.floor(now.getTime() / 1000)}\n${summary}\n`)
    fs.renameSync(tmp, target)
    return { marker: target, written: true }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // best effort; never mask the original error
    }
    log.warn(`state marker skipped (${target}): ${err.message}`)
    return { marker: target, written: false, error: err }
  }
}

module.exports = { MARKER_NAME, stateDir, writeSuccessMarker }
