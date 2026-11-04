const { MongoClient } = require('mongodb')
const { EJSON } = require('bson')
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const WORK = '/work'
const DUMP = path.join(WORK, 'dump')

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function env(name, { required = true, fallback } = {}) {
  const v = process.env[name]
  if (!v && required) throw new Error(`${name} is required`)
  return v || fallback
}

async function dump() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(DUMP, { recursive: true })

  const client = new MongoClient(env('MONGO_URI'), { serverSelectionTimeoutMS: 20000 })
  await client.connect()
  const db = client.db()

  let collections = []
  let documents = 0
  try {
    const list = await db.listCollections().toArray()
    for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const docs = await db.collection(c.name).find({}).toArray()
      fs.writeFileSync(path.join(DUMP, `${c.name}.json`), EJSON.stringify(docs, { relaxed: false }))
      documents += docs.length
      collections.push(`${c.name}: ${docs.length}`)
    }
  } finally {
    await client.close()
  }

  console.log(collections.join('\n'))
  console.log(`TOTAL collections=${collections.length} documents=${documents}`)

  if (documents === 0) throw new Error('dump contained no documents')
  return { collections: collections.length, documents }
}

function archive(name) {
  const file = path.join(WORK, name)
  execFileSync('tar', ['czf', file, '-C', DUMP, '.'], { stdio: 'inherit' })
  const size = fs.statSync(file).size
  if (size < 1000) throw new Error(`archive suspiciously small: ${size} bytes`)
  return { file, size }
}

async function upload(file) {
  const s3 = new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION', { required: false, fallback: 'us-east-1' }),
    forcePathStyle: true,
    credentials: {
      accessKeyId: env('S3_ACCESS_KEY'),
      secretAccessKey: env('S3_SECRET_KEY'),
    },
  })

  const bucket = env('S3_BUCKET')
  const key = path.basename(file)

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file),
      ContentType: 'application/gzip',
    }),
  )
  console.log(`uploaded s3://${bucket}/${key}`)
  return { s3, bucket, key }
}

async function prune({ s3, bucket, key }) {
  const days = Number(env('RETENTION_DAYS', { required: false, fallback: '14' }))
  if (!Number.isFinite(days) || days <= 0) return

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: '' }))
  const stale = (listed.Contents || [])
    .filter((o) => o.Key !== key && o.LastModified && o.LastModified.getTime() < cutoff)
    .map((o) => ({ Key: o.Key }))

  if (stale.length === 0) {
    console.log(`retention: nothing older than ${days} days`)
    return
  }
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale } }))
  console.log(`retention: removed ${stale.length} archive(s) older than ${days} days`)
}

async function main() {
  const name = `adb-${env('S3_PREFIX', { required: false, fallback: 'rossmoney' })}_${stamp()}.tar.gz`
  const stats = await dump()
  const { file, size } = archive(name)
  console.log(`archive: ${name} (${size} bytes)`)
  const uploaded = await upload(file)
  await prune(uploaded)
  fs.rmSync(WORK, { recursive: true, force: true })
  console.log(`done: collections=${stats.collections} documents=${stats.documents} bytes=${size}`)
}

main().catch((err) => {
  console.error('BACKUP FAILED:', err.message)
  process.exit(1)
})
