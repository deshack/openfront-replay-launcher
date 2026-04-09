#!/bin/sh
set -e

# Start Docker daemon in background
dockerd &

echo "Waiting for Docker daemon..."
WAIT=0
until docker info >/dev/null 2>&1; do
  sleep 1
  WAIT=$((WAIT + 1))
  if [ "$WAIT" -ge 60 ]; then
    echo "ERROR: Docker daemon did not start within 60s" >&2
    exit 1
  fi
done
echo "Docker daemon ready."

# Start the builder app
exec node src/index.js
