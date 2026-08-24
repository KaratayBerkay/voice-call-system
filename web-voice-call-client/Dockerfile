FROM node:22-alpine AS build
WORKDIR /app
# node:22-alpine's bundled npm (10.x) has a lockfile-sync check that
# misfires on this lockfile's optional peer deps (e.g. lru-cache, pulled in
# optionally by a nitro storage driver) and refuses `npm ci`; npm 11 doesn't
# have this issue.
RUN npm install -g npm@11
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Vite bakes VITE_* into the client bundle at build time -- these have to be
# build args (not just runtime `environment:` in compose), or the browser
# bundle would still contain whatever default config.ts falls back to.
ARG VITE_SIGNALING_URL
ARG VITE_STUN_URL
ARG VITE_TURN_URL
ARG VITE_TURN_USERNAME
ARG VITE_TURN_PASSWORD
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL \
    VITE_STUN_URL=$VITE_STUN_URL \
    VITE_TURN_URL=$VITE_TURN_URL \
    VITE_TURN_USERNAME=$VITE_TURN_USERNAME \
    VITE_TURN_PASSWORD=$VITE_TURN_PASSWORD

RUN npm run build

# Nitro's node-server preset output is self-contained (deps bundled into
# .output/server/*.mjs) -- no node_modules needed at runtime.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
COPY --from=build /app/.output ./.output
EXPOSE 3002
CMD ["node", ".output/server/index.mjs"]
