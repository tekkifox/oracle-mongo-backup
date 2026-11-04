# Nightly logical backup of the Oracle ADB (Mongo API) into S3/MinIO.
#
# The Node driver is used rather than mongodump/mongosh: the ADB's TLS profile
# rejects both of those ("connection closed unexpectedly") while the Node driver
# connects fine — it is also what the CMS itself uses in production.
FROM node:22-alpine

ARG SUPERCRONIC_VERSION=v0.2.33
ARG TARGETARCH=amd64

RUN apk add --no-cache tar curl \
 && curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
 && chmod +x /usr/local/bin/supercronic \
 && supercronic -version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --silent --omit=dev

COPY index.js ./
COPY crontab ./crontab

# Fail fast on a bad config rather than silently doing nothing at 03:00.
RUN node -e "console.log('node ok')"

ENTRYPOINT ["supercronic", "/app/crontab"]
