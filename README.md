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
6. Writes the completion marker at `/state/last-success` (see below).

Every run is logged to stdout; a failed run exits non-zero. The host-side
uptime check does **not** read `docker logs` — it reads the completion marker
described below.

## Completion marker

After a successful run the backup writes `/state/last-success`. The state
directory is bind-mounted from the host (`/home/ross/oracle-backup-state` on
`photos`); set `STATE_DIR` to use a different mount point inside the
container.

The marker has two lines:

1. completion time as Unix epoch seconds, nothing else
2. a short human summary, e.g. `collections=23 documents=37374 bytes=3611403`

It is written atomically — a temp file in the same directory, then `rename` —
so a reader never sees a half-written file. It is written **only on success**:
a failed run does not create or touch it. If the state directory is missing or
not writable the backup still succeeds and logs `state marker skipped (...)`.

The host-side check in `tekkifox/infrastructure-as-code` depends on this
contract. It deliberately reads the marker instead of `docker logs`, because
recreating the container wipes its logs and made the log-based check go red
after every converge.

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
| `STATE_DIR` | no | `/state` | where `last-success` is written |

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

CI builds `linux/amd64` and `linux/arm64` and pushes to GHCR on every push to
`main`, tagged `:latest` and with the commit SHA.

## Deploy

The stack is owned by the fleet's Ansible deploy path, on host `photos` as
stack `photos-oracle-mongo-backup`. It declares
`ghcr.io/tekkifox/oracle-mongo-backup:latest`; Ansible pulls and recreates it,
so the compose file does not pin a commit tag.

On a push to `main`, `.github/workflows/build.yml` joins the tailnet and asks
the fleet deploy seat to deploy that stack. It never writes the compose file.

The SHA tag is still published so a bad release can be rolled back by pinning
the stack to `ghcr.io/tekkifox/oracle-mongo-backup:<sha>`.
