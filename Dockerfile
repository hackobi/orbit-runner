# The game server and the built client in one image, for Railway or any host
# that runs a container and sets PORT.

# Node runs the server's TypeScript directly, which needs 22.19 or later.
FROM node:22.22-slim AS build
WORKDIR /app
# The Mac app and the browser tests are not built here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.22-slim
WORKDIR /app
ENV NODE_ENV=production ORBIT_SERVER_HOST=0.0.0.0 ORBIT_CLIENT_DIR=dist
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "src/server/main.ts"]
