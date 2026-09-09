FROM node:20-bookworm-slim AS base

ENV APP_HOME=/app
WORKDIR ${APP_HOME}

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json eslint.config.mjs ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV APP_HOME=/app
ENV HOST=0.0.0.0
ENV PORT=3000
ENV QUOTE_DOCUMENT_STORAGE_ROOT=/var/lib/pesaschile/quote-documents
WORKDIR ${APP_HOME}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/lib/pesaschile/quote-documents

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/infrastructure/persistence/postgres/migrations ./dist/infrastructure/persistence/postgres/migrations

RUN useradd --system --create-home --home-dir /home/nodeapp --shell /usr/sbin/nologin nodeapp \
  && chown -R nodeapp:nodeapp ${APP_HOME} /var/lib/pesaschile

USER nodeapp

EXPOSE 3000
VOLUME ["/var/lib/pesaschile/quote-documents"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["dumb-init", "--", "node", "dist/server.js"]
