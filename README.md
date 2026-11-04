# oracle-mongo-backup

Nightly logical backup of the Oracle Autonomous Database (MongoDB API) into
S3-compatible storage.

The CMS stores its content in an Oracle ADB exposed through Oracle's MongoDB
compatible API. Oracle keeps 60 days of automatic backups, but those live in the
same tenancy — this gives an independent, portable copy that can be restored
into any MongoDB.

## Why not mongodump

`mongodump` and `mongosh` both fail against this database:

```
failed to configure TLS ... connection closed unexpectedly by the other side: EOF
```

The Node driver connects fine (it is what the CMS uses), so the dump is done
with `mongodb` + `bson` EJSON, which preserves ObjectId, Date and Binary types.

The image also caps TLS at 1.2 (`NODE_OPTIONS=--tls-max-v1.2`). From some
networks the handshake at TLS 1.3 is closed by the database before any Mongo
protocol is exchanged; the same connection succeeds at 1.2 with
`ECDHE-RSA-AES256-GCM-SHA384`.

The ADB also has a network ACL. Only the addresses in `whitelisted-ips` can
connect — add the host before deploying.

## What it does

1. Connects with `MONGO_URI` and lists every collection.
2. Writes each collection to `<collection>.json` as canonical EJSON.
3. Tars and gzips the dump.
4. Uploads it to `s3://$S3_BUCKET/<prefix>_<timestamp>.tar.gz`.
5. Deletes archives older than `RETENTION_DAYS`.

Every run is logged to stdout; a failed run exits non-zero so the container
restart policy and logs show it.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MONGO_URI` | yes | — | ADB Mongo API connection string |
| `S3_ENDPOINT` | yes | — | e.g. `https://s3.example.com` |
| `S3_BUCKET` | yes | — | e.g. `oracle-adb` |
| `S3_ACCESS_KEY` | yes | — | access key |
| `S3_SECRET_KEY` | yes | — | secret key |
| `S3_REGION` | no | `us-east-1` | MinIO ignores it, the SDK does not |
| `S3_PREFIX` | no | `db` | filename prefix, e.g. the database name |
| `RETENTION_DAYS` | no | `14` | prune archives older than this |

## Restore

```bash
mc cp local/<bucket>/adb-db_20261104_031000.tar.gz .
tar xzf adb-db_20261104_031000.tar.gz -C ./dump
# each file is canonical EJSON; mongoimport --jsonArray needs relaxed mode:
for f in ./dump/*.json; do
  name=$(basename "$f" .json)
  mongoimport --uri "$TARGET_URI" --collection "$name" --file "$f" --jsonArray
done
```

Or load them with the Node driver and `EJSON.parse` — the documents are stored
in canonical form so types survive.

## Schedule

The image runs `supercronic` with the crontab in `crontab` (03:10 UTC nightly).
Set `TZ` if you want a different local time.

## Build

```bash
docker build -t oracle-mongo-backup:local .
docker run --rm --env-file .env oracle-mongo-backup:local   # one-off
```
