# Multi-arch friendly (node:22-alpine publishes amd64 + arm64); build with
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/justizin/inaccessibility:0.1.0 --push .
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server.js"]
