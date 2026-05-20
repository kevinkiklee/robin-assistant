FROM node:24-slim

# Install build tooling for native deps (better-sqlite3, sqlite-vec, kuzu, node-llama-cpp)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@10

WORKDIR /app

# Copy package manifest first (better layer caching)
COPY package.json pnpm-lock.yaml .pnpmrc ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json tsconfig.build.json biome.json ./
COPY system ./system

# Build
RUN pnpm build

# Default user-data path inside container; users should volume-mount this
ENV ROBIN_USER_DATA_DIR=/app/user-data
VOLUME ["/app/user-data"]

# Expose the HTTP hooks/health port
EXPOSE 41273

ENTRYPOINT ["node", "dist/surfaces/cli/index.js"]
CMD ["daemon", "--foreground"]
