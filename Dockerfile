FROM node:22-alpine

WORKDIR /app

# APP_VERSION is passed by CI (release tag); falls back to package.json at runtime
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

COPY package.json package-lock.json .npmrc ./
ARG NODE_AUTH_TOKEN=""
RUN NPM_CONFIG_//npm.pkg.github.com/:_authToken="${NODE_AUTH_TOKEN}" npm ci

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY drizzle/ drizzle/
COPY seed/ seed/
COPY src/ src/

RUN npm run build

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run migrations when SQL files exist (drizzle-kit exits 1 on an empty
# journal), then seed the ticker reference from the bundled snapshot when
# the table is still empty. Seed failure is non-fatal: /search falls back
# to the provider tier. The k8s CronJob refreshes live data via --url.
CMD ["sh", "-c", "ls drizzle/*.sql >/dev/null 2>&1 && npm run db:migrate; node dist/scripts/tickerref-sync.js --file seed --if-empty || echo '[boot] tickerref seed skipped'; node dist/server.js"]
