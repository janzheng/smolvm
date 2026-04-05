#!/bin/sh
# DNS-based egress filter for smolvm machinees.
# Usage: dns-filter.sh domain1.com domain2.com ...
#
# Pre-resolves allowed domains to /etc/hosts then blocks all DNS resolution.
# This is an application-layer filter — not a network firewall.

set -e

ALLOWED_DOMAINS="$@"

if [ -z "$ALLOWED_DOMAINS" ]; then
    echo "dns-filter: no domains specified, skipping" >&2
    exit 0
fi

echo "dns-filter: activating for: $ALLOWED_DOMAINS" >&2

# Pre-resolve allowed domains while DNS still works
for domain in $ALLOWED_DOMAINS; do
    ip=$(getent hosts "$domain" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -n "$ip" ]; then
        echo "$ip $domain" >> /etc/hosts
        echo "dns-filter: resolved $domain -> $ip" >&2
    else
        echo "dns-filter: WARNING could not pre-resolve $domain" >&2
    fi
done

# Block all future DNS by pointing at localhost (no server on :53)
echo 'nameserver 127.0.0.1' > /etc/resolv.conf
echo '# smolvm DNS filter active — only pre-resolved domains accessible' >> /etc/resolv.conf

echo "dns-filter: activated" >&2
