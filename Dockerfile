# SolanaGO: one small Node server. There are no packages to install.
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The database lives on a disk you attach at /data, so it survives restarts and new versions.
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/solanago.db

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
