#!/bin/sh
# Runs after every certificate check, renewed or not. Comparing the files means a run that failed
# or crashed part way is repaired by the next check instead of waiting for the next renewal.
set -eu
CERT="/var/lib/ths-mexc-acme/certificates/$LEGO_DOMAINS.crt"
KEY="/var/lib/ths-mexc-acme/certificates/$LEGO_DOMAINS.key"
if cmp -s "$CERT" /etc/ths-mexc-tls/fullchain.pem && cmp -s "$KEY" /etc/ths-mexc-tls/privkey.pem; then
  exit 0
fi
install -d -m 0700 -o root -g root /etc/ths-mexc-tls
install -m 0644 -o root -g root "$CERT" /etc/ths-mexc-tls/fullchain.pem.new
install -m 0600 -o root -g root "$KEY" /etc/ths-mexc-tls/privkey.pem.new
mv -f /etc/ths-mexc-tls/privkey.pem.new /etc/ths-mexc-tls/privkey.pem
mv -f /etc/ths-mexc-tls/fullchain.pem.new /etc/ths-mexc-tls/fullchain.pem
# A reload keeps connections open and does not touch the gateway process.
nginx -t
systemctl reload nginx
