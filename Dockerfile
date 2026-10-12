# Still — local-first authenticator.
# Static build only: there is no backend, no database, and no secrets leave
# the browser. The runtime stage just serves dist/ with security headers.
#
#   docker build -t still-authenticator:local .
#   docker run --rm --init -p 127.0.0.1:8080:8080 still-authenticator:local
#
# Then open http://localhost:8080 (localhost is a secure context, so WebAuthn
# works). For any other host, terminate TLS in front of the container.
#
# Building needs network access for the base images and the npm registry.
# Running the image needs none: it uses only widely supported Dockerfile
# features (a classic builder works too) and the Python standard library.

ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.13

# ---------- build: compile the Vite bundle and the service worker ----------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

# Install dependencies first so code changes do not invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Unit tests (RFC 6238 vectors, encryption, import parsing, static server).
# The Python server tests skip themselves when python3 is absent.
RUN npm test

RUN npm run build

# ---------- runtime: stdlib Python static server, no third-party packages ----------
FROM python:${PYTHON_VERSION}-alpine AS runtime

LABEL org.opencontainers.image.title="Still authenticator" \
      org.opencontainers.image.description="Local-first encrypted TOTP authenticator (static build)" \
      org.opencontainers.image.source="https://github.com/sarakplaystore/2fa-Ai"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DIST_DIR=/app/dist \
    STILL_HSTS_MAX_AGE=0

WORKDIR /app

# serve.py before dist/ so a rebuild after a code-only change stays cacheable.
COPY scripts/serve.py ./scripts/serve.py
COPY --from=build /app/dist ./dist

# Run unprivileged, with a read-only-friendly layout.
RUN addgroup -S -g 10001 still \
 && adduser -S -u 10001 -G still still \
 && chown -R still:still /app
USER still

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["python", "/app/scripts/serve.py", "--healthcheck"]

ENTRYPOINT ["python", "/app/scripts/serve.py"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--dir", "/app/dist"]
