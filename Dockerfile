# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=0

# Install runtime dependencies required by Firefox/Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
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
    libxss1 \
    libxtst6 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Download and place Camoufox (Linux build) into the expected directory
ARG CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip"
RUN set -eux; \
        mkdir -p /app/camoufox-linux; \
        curl -fsSL "$CAMOUFOX_URL" -o /tmp/camoufox.zip; \
        unzip -q /tmp/camoufox.zip -d /tmp/camoufox; \
        CAMOUFOX_BIN="$(find /tmp/camoufox -type f \( -name 'camoufox' -o -name 'camoufox*' \) -print -quit)"; \
        if [ -z "$CAMOUFOX_BIN" ]; then \
            echo "Camoufox binary not found in archive contents:" >&2; \
            ls -R /tmp/camoufox >&2 || true; \
            exit 1; \
        fi; \
        mv "$CAMOUFOX_BIN" /app/camoufox-linux/camoufox; \
        chmod +x /app/camoufox-linux/camoufox; \
        rm -rf /tmp/camoufox.zip /tmp/camoufox

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=7860 \
    WS_PORT=9998 \
    HOST=0.0.0.0 \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox

EXPOSE 7860 9998

CMD ["node", "main.js"]
