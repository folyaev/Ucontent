FROM cloudflare/cloudflared:latest AS cloudflared

FROM node:22-bookworm

WORKDIR /app

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ffmpeg ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
    libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
    libxrandr2 libxrender1 libxss1 libxtst6 xvfb x11vnc novnc websockify openbox \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY Remotion/package*.json ./Remotion/
RUN cd Remotion && npm ci && npx remotion browser ensure

COPY tools/video-scene-cutter/requirements.txt ./tools/video-scene-cutter/requirements.txt
COPY tools/utrends/requirements.txt ./tools/utrends/requirements.txt
RUN python3 -m venv .venv \
  && ./.venv/bin/python -m pip install --upgrade pip \
  && ./.venv/bin/python -m pip install --upgrade yt-dlp gallery-dl \
  && ./.venv/bin/python -m pip install -r tools/video-scene-cutter/requirements.txt \
  && if [ -f tools/utrends/requirements.txt ]; then ./.venv/bin/python -m pip install -r tools/utrends/requirements.txt; fi

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

COPY . .

EXPOSE 5197
EXPOSE 6080
CMD ["node", "server.mjs"]
