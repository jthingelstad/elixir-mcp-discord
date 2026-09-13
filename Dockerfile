# A container for operators who would rather not manage node on the host.
#
#   I=~/.elixir-mcp-discord/myclan        # an instance made by `npm run setup`
#   docker build -t elixir-mcp-discord .
#   docker run -d --name elixir-mcp-discord-myclan --restart unless-stopped \
#     --env-file $I/.env \
#     -v "$I/state:/app/state" \
#     -v "$I/agent:/app/agent" \
#     elixir-mcp-discord
#
# Two mounts are the whole point: state/ so cursors, the run ledger and spend
# survive a container replacement (without it every restart re-seeds and the
# budget forgets itself), and agent/ so a prompt edit on the host takes effect
# on the next run with no rebuild — the same "a prompt change is never a
# deploy" rule as everywhere else. The .env is passed as environment, never
# copied into the image.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY agent ./agent

RUN mkdir -p state && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
