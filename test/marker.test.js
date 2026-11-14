const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MARKER_NAME, writeSuccessMarker } = require('../marker')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'))
}

function quietLog() {
  const lines = []
  return { lines, warn: (line) => lines.push(line) }
}

test('writes epoch seconds on line 1 and the summary on line 2', () => {
  const dir = tempDir()
  const now = new Date('2026-11-14T03:10:00Z')
  const summary = 'collections=23 documents=37374 bytes=3611403'

  const result = writeSuccessMarker(summary, { dir, now, log: quietLog() })

  assert.equal(result.written, true)
  const raw = fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8')
  const [epoch, rest] = raw.split('\n')
  assert.equal(epoch, String(Math.floor(now.getTime() / 1000)))
  assert.equal(epoch, '1794625800')
  assert.equal(rest, summary)
  assert.equal(raw.split('\n').filter(Boolean).length, 2)
})

test('replaces the marker atomically via rename in the same directory', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, MARKER_NAME), '1\nold\n')

  const renames = []
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    renames.push({ from, to })
    // The old marker is still readable until the rename happens.
    assert.equal(fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8'), '1\nold\n')
    return realRename(from, to)
  }

  try {
    writeSuccessMarker('collections=1 documents=1 bytes=1000', { dir, log: quietLog() })
  } finally {
    fs.renameSync = realRename
  }

  assert.equal(renames.length, 1)
  assert.equal(path.dirname(renames[0].from), dir)
  assert.equal(path.dirname(renames[0].to), dir)
  assert.match(path.basename(renames[0].from), /\.tmp$/)
  assert.equal(path.basename(renames[0].to), MARKER_NAME)

  // No temp file is left behind.
  assert.deepEqual(fs.readdirSync(dir), [MARKER_NAME])
})

test('missing state directory skips the write without throwing', () => {
  const dir = path.join(tempDir(), 'does-not-exist')
  const log = quietLog()

  const result = writeSuccessMarker('collections=1 documents=1 bytes=1000', { dir, log })

  assert.equal(result.written, false)
  assert.equal(fs.existsSync(path.join(dir, MARKER_NAME)), false)
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /state marker skipped/)
})

test('a failed write leaves an existing marker untouched', () => {
  const dir = tempDir()
  const target = path.join(dir, MARKER_NAME)
  fs.writeFileSync(target, '1763000000\ncollections=9 documents=9 bytes=9999\n')

  const realRename = fs.renameSync
  fs.renameSync = () => {
    throw new Error('disk went away')
  }

  let result
  try {
    result = writeSuccessMarker('collections=2 documents=2 bytes=2000', { dir, log: quietLog() })
  } finally {
    fs.renameSync = realRename
  }

  assert.equal(result.written, false)
  assert.match(result.error.message, /disk went away/)
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    '1763000000\ncollections=9 documents=9 bytes=9999\n',
  )
  // The half-written temp file is cleaned up.
  assert.deepEqual(fs.readdirSync(dir), [MARKER_NAME])
})
