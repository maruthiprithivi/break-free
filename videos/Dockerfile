# Renders every Break Free composition. Nothing is installed or run on a developer machine:
#   docker build -t break-free-videos .
#   docker run --rm -v "$PWD/out:/app/out" break-free-videos
FROM node:22-bookworm-slim

# Chromium runtime libraries Remotion needs, ffprobe for the audio-driven timing pass,
# and fallback fonts in case the Google Fonts fetch is unavailable at render time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg fonts-dejavu-core fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund
RUN npx remotion browser ensure

COPY tsconfig.json remotion.config.ts render.sh ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public

ENV REMOTION_CONCURRENCY=8
CMD ["bash", "render.sh"]
