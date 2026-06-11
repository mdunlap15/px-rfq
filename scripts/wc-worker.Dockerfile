# World Cup player-prop scraper worker — runs as a SEPARATE Railway service
# so headless Chromium never shares a container with the live trading service.
#
# Railway setup (one-time, dashboard):
#   1. Project → New Service → GitHub Repo → mdunlap15/px-rfq
#   2. Service → Settings → Build → set "Dockerfile Path" to
#      scripts/wc-worker.Dockerfile   (or set env RAILWAY_DOCKERFILE_PATH)
#   3. Service → Variables: PX_ACCESS_KEY, PX_SECRET_KEY, SUPABASE_URL,
#      SUPABASE_SERVICE_KEY  (PX_BASE_URL optional; WC_SCRAPE_LOOP_MINUTES
#      optional, default 10; WC_TOURNAMENT_IDS optional, default 53)
#   4. No public networking needed — it's a background worker.
#
# The main service keeps building via nixpacks (this file is not at repo
# root, so Railway's auto-detection ignores it there).
#
# Loop behavior: scrapes every WC_SCRAPE_LOOP_MINUTES (default 10),
# self-tightens to every 2 min when a match kicks off within 45 min, skips
# in-play matches, and the live service fail-safes quoting off within 15 min
# if this worker ever stops.

FROM node:20-bookworm-slim

# Debian's chromium pulls every shared lib puppeteer needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Use the system chromium; skip puppeteer's own browser download at install.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["node", "scripts/dk-wc-props-worker.js", "--loop"]
