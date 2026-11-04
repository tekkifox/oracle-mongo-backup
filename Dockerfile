# Nightly logical backup of the Oracle ADB (Mongo API) into S3/MinIO.
#
# The Node driver is used rather than mongodump/mongosh: the ADB's TLS profile
# rejects both of those ("connection closed unexpectedly") while the Node driver
# connects fine — it is also what the CMS itself uses in production.
FROM node:22-alpine

RUN apk add --no-cache tar

# The ADB's Mongo API fails the TLS handshake at 1.3 from some networks
# ("Client network socket disconnected before secure TLS connection was
# established"); capping at 1.2 makes it negotiate the same suite openssl does.
ENV NODE_OPTIONS=--tls-max-v1.2

WORKDIR /app

COPY package.json ./
RUN npm install --silent --omit=dev

COPY index.js ./
COPY crontab /etc/crontabs/root

# busybox crond, already in the base image: -f foreground, -L log to stdout so
# `docker logs` shows every run.
CMD ["crond", "-f", "-l", "8", "-L", "/dev/stdout"]
