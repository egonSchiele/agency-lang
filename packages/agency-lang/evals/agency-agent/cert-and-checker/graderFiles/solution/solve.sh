#!/usr/bin/env bash
set -e
mkdir -p ssl
openssl ecparam -name prime256v1 -genkey -noout -out ssl/server.key
chmod 600 ssl/server.key
openssl req -new -x509 -key ssl/server.key -days 90 -subj "/O=Northwind Internal/CN=build.northwind.internal" -out ssl/server.crt
cat ssl/server.key ssl/server.crt > ssl/server.pem
{
  openssl x509 -in ssl/server.crt -noout -subject
  openssl x509 -in ssl/server.crt -noout -dates
  openssl x509 -in ssl/server.crt -noout -fingerprint -sha256
} > ssl/verification.txt
cp "$(dirname "$0")/check_cert.py" check_cert.py
