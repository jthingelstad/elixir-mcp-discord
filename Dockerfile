# A container for operators who would rather not manage node on the host.
#
#   I=~/.elixir-mcp-discord/myclan        # an instance made by `npm run setup`
#   docker build -t elixir-mcp-discord .
#   docker run -d --name elixir-mcp-discord-myclan --restart unless-stopped \
#     --user "$(id -u):$(id -g)" \
#     -v "$I:/instance" \
#     elixir-mcp-discord
#
# The INSTANCE is mounted, whole: .env, config.json, agent/ and state/. Until
# 2026-09-25 this recipe mounted only state/ and agent/ and passed .env as
# --env-file, which had been right until settings moved into config.json
# (2026-09-15) — after that a container ran with no budgets (unset means
# unlimited), no admins and no ask channel, and a setting changed from the DM
# was written inside the container and lost with it. One mount is also what
# keeps "a prompt change is never a deploy": edit agent/ on the host and the
# next run reads it.
#
# --user is the host user that owns the instance, so the bot can read its
# 0600 .env and write state/, config.json and agent/ (and commit them, when
# the instance is a git repository — git is in the image for that).
#
# Setup runs in the same image, interactively, with no node on the host:
#
#   docker run -it --rm --user "$(id -u):$(id -g)" -v "$I:/instance" \
#     elixir-mcp-discord node src/setup.js /instance

# The build context, once, so the final stage can take .git's HEAD and refs
# when the context has them (a checkout) and an empty .git when it does not
# (a tarball) — COPY of a path that may be absent would fail the build.
FROM node:24-alpine AS context
WORKDIR /src
COPY . .
RUN mkdir -p .git

FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app
ENV NODE_ENV=production
# Where the instance is (src/config.js), and that a supervisor restarts the
# process when it exits — Docker's restart policy — so a setting that needs a
# restart (COMMAND_PREFIX, EVENT_POLL_SECONDS) is applied by exiting.
ENV INSTANCE_DIR=/instance
ENV SERVICE_MANAGED=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The code, and the example prompts setup copies into a new instance.
COPY src ./src
COPY agent ./agent
# Which commit this is, for the boot line's build=<version>+<sha>.
COPY --from=context /src/.git ./.git

VOLUME /instance
USER node

CMD ["node", "src/index.js"]
