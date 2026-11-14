const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { main } = require('../index')
const { MARKER_NAME } = require('../marker')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-test-'))
}

function withStateDir(dir) {
  const previous = process.env.STATE_DIR
  process.env.STATE_DIR = dir
  return () => {
    if (previous === undefined) delete process.env.STATE_DIR
    else process.env.STATE_DIR = previous
  }
}

function successfulSteps(overrides = {}) {
  return {
    dump: async () => ({ collections: 23, documents: 37374 }),
    archive: () => ({ file: '/work/adb-db_20261114_031000.tar.gz', size: 3611403 }),
    upload: async () => ({ s3: {}, bucket: 'b', key: 'adb-db_20261114_031000.tar.gz' }),
    prune: async () => {},
    ...overrides,
  }
}

test('a successful run writes the marker with epoch seconds and the summary', async () => {
  const dir = tempDir()
  const restore = withStateDir(dir)
  const before = Math.floor(Date.now() / 1000)

  try {
    await main(successfulSteps())
  } finally {
    restore()
  }

  const after = Math.floor(Date.now() / 1000)
  const raw = fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8')
  const [epoch, summary, ...extra] = raw.split('\n')

  assert.equal(extra.length, 1) // only the trailing newline
  assert.match(summary, /^collections=23 documents=37374 bytes=3611403$/)
  const seconds = Number(epoch)
  assert.equal(String(seconds), epoch)
  assert.ok(seconds >= before && seconds <= after, `${epoch} is not a plausible current epoch`)

  // Atomic rename leaves no temp files behind.
  assert.deepEqual(fs.readdirSync(dir), [MARKER_NAME])
})

test('a failed run leaves an existing marker untouched', async () => {
  const dir = tempDir()
  const target = path.join(dir, MARKER_NAME)
  const original = '1763000000\ncollections=9 documents=9 bytes=9999\n'
  fs.writeFileSync(target, original)
  const before = fs.statSync(target)
  const restore = withStateDir(dir)

  try {
    await assert.rejects(
      main(successfulSteps({ dump: async () => { throw new Error('connect ECONNREFUSED') } })),
      /ECONNREFUSED/,
    )
  } finally {
    restore()
  }

  const after = fs.statSync(target)
  assert.equal(fs.readFileSync(target, 'utf8'), original)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.ino, before.ino)
})
