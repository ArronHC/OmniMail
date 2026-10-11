FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build-ca,required=false \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    npm ci --no-audit --no-fund ${HTTPS_PROXY:+--https-proxy="$HTTPS_PROXY"}
COPY tsconfig.json ./
COPY src ./src
RUN --mount=type=secret,id=build-ca,required=false \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    npm run build && npm prune --omit=dev --no-audit --no-fund ${HTTPS_PROXY:+--https-proxy="$HTTPS_PROXY"}
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:9090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
