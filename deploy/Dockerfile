# Classic Grid / Day1 — Vite client + Express API (CO2T-TS co2t-tsi deploy)
FROM node:20.19-bookworm-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
   && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY contracts ./contracts

RUN npm run build

FROM node:20.19-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
   && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
COPY contracts ./contracts
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV DAY1_API_PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
