FROM node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c AS build

ARG AIKAYUN_RELEASE_ID=local-development
ARG AIKAYUN_RELEASE_VERSION=0.0.0-dev
ARG AIKAYUN_SOURCE_COMMIT=unknown

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/money/package.json packages/money/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @aikayun/web...
COPY scripts/release/prune-node-modules.mjs scripts/release/prune-node-modules.mjs
COPY packages/contracts packages/contracts
COPY packages/money packages/money
COPY apps/web apps/web
RUN pnpm --filter @aikayun/contracts build \
  && pnpm --filter @aikayun/money build \
  && pnpm --filter @aikayun/web build \
  && node scripts/release/prune-node-modules.mjs apps/web/.output/server/node_modules \
  && find apps/web/.output/server/node_modules -type f -name '*.ts' -delete \
  && find apps/web/.output -type f \( -name '*.map' -o -name '*.d.ts' -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'CONTRIBUTING*' \) -delete \
  && test -z "$(find apps/web/.output -type f \( -name '*.map' -o -name '*.d.ts' \) -print -quit)"

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS runtime

ARG AIKAYUN_RELEASE_ID=local-development
ARG AIKAYUN_RELEASE_VERSION=0.0.0-dev
ARG AIKAYUN_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="AiKayun Web" \
  org.opencontainers.image.version="$AIKAYUN_RELEASE_VERSION" \
  org.opencontainers.image.revision="$AIKAYUN_SOURCE_COMMIT" \
  io.aikayun.release.id="$AIKAYUN_RELEASE_ID"
ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
WORKDIR /app
COPY --from=build --chown=1000:1000 /workspace/apps/web/.output/ ./
USER 1000:1000
EXPOSE 3000
CMD ["server/index.mjs"]
