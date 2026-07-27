# One image, one process: the built client and the game server together.
#
# `server/index.ts` serves `dist/` and the WebSocket from the same origin, so
# there is no second container, no CORS and no static bucket to keep in sync.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app

# The server imports the simulation straight out of src/ — the same code the
# browser runs. Nothing is compiled ahead of time; Bun runs the TypeScript.
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist dist
COPY --from=build /app/src src
COPY --from=build /app/server server

# Kitchens live here, on a volume — see docker-compose.yml. Without that, every
# deploy would silently wipe everyone's layout.
ENV COOKD_SAVE_DIR=/app/saves
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "server/index.ts"]
