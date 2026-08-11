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
ENV PUPPETEER_CACHE_DIR=/opt/pesaschile/puppeteer
ENV QUOTE_DOCUMENT_STORAGE_ROOT=/var/lib/pesaschile/quote-documents
ENV QUOTE_PDF_EXECUTABLE_PATH=/opt/pesaschile/bin/chrome-headless-shell
WORKDIR ${APP_HOME}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/pesaschile/bin /var/lib/pesaschile/quote-documents

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/infrastructure/persistence/postgres/migrations ./dist/infrastructure/persistence/postgres/migrations

RUN npx puppeteer browsers install chrome-headless-shell@stable --path ${PUPPETEER_CACHE_DIR} \
  && find ${PUPPETEER_CACHE_DIR} -path '*chrome-headless-shell-linux64/chrome-headless-shell' -exec ln -sf {} ${QUOTE_PDF_EXECUTABLE_PATH} \;

RUN useradd --system --create-home --home-dir /home/nodeapp --shell /usr/sbin/nologin nodeapp \
  && chown -R nodeapp:nodeapp ${APP_HOME} /opt/pesaschile /var/lib/pesaschile

USER nodeapp

EXPOSE 3000
VOLUME ["/var/lib/pesaschile/quote-documents"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["dumb-init", "--", "node", "dist/server.js"]
