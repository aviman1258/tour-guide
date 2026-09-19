# Tour Guide server + static app in one container (Render, App Runner, anywhere Docker runs).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web ./web

# Learned time estimates live here; mount a persistent disk at /app/data to keep them across deploys.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3001
EXPOSE 3001
CMD ["node", "server/index.js"]
