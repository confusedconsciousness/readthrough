# Odyssey, hosted mode. Configure with the variables in .env.example.
# Postgres when DATABASE_URL is set; otherwise SQLite at /data/odyssey.db (mount a volume there to keep it).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production ODYSSEY_SQLITE=/data/odyssey.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY server.js db.js github.js ai.js index.html app.js styles.css demo.json ./
COPY fonts ./fonts
USER node
VOLUME /data
EXPOSE 4400
CMD ["node", "server.js"]
