# The web app (app/) for Railway: build with Vite, serve app/dist with app/serve.mjs.
# The app reads deployments/elysium-testnet.json, so the build context is the repo root.
# Railway variables used at build time: VITE_PRIVY_APP_ID (required), VITE_ELYSIUM_RPC (the keyed Elysium RPC URL;
# without it the app uses the public, rate-limited one).

FROM node:22-alpine AS build
WORKDIR /repo
COPY app/package.json app/package-lock.json app/
RUN npm ci --prefix app
COPY deployments deployments
COPY app app
ARG VITE_PRIVY_APP_ID
ARG VITE_ELYSIUM_RPC
RUN test -n "$VITE_PRIVY_APP_ID" || (echo "Set VITE_PRIVY_APP_ID in Railway variables" && exit 1)
RUN npm --prefix app run build

FROM node:22-alpine
WORKDIR /srv
COPY --from=build /repo/app/dist app/dist
COPY app/serve.mjs app/serve.mjs
ENV NODE_ENV=production
USER node
CMD ["node", "app/serve.mjs"]
