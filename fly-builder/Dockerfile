# Builder Dockerfile
# Needs Docker daemon access to build/push game images.
# Uses docker:dind (Docker-in-Docker) as base, adds Node + git.

# Pin to a minor version so patch updates are controlled.
# Update intentionally after testing; never use a bare major tag.
FROM docker:27.5-dind

RUN apk add --no-cache nodejs npm git

WORKDIR /app

COPY fly-builder/package*.json ./
RUN npm ci --omit=dev

COPY fly-builder/src/ ./src/
COPY fly-builder/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
