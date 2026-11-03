FROM node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c AS build

ARG AIKAYUN_RELEASE_ID=local-development
ARG AIKAYUN_RELEASE_VERSION=0.0.0-dev
ARG AIKAYUN_REQUIRE_LICENSE_CONFIG=false
ARG AIKAYUN_PRODUCTION_LICENSE_ISSUER=
ARG AIKAYUN_PRODUCTION_LICENSE_ROOT_KID=

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/money/package.json packages/money/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @aikayun/api...
COPY scripts/release/prune-node-modules.mjs scripts/release/prune-node-modules.mjs
COPY packages/contracts packages/contracts
COPY packages/money packages/money
COPY apps/api apps/api
RUN --mount=type=secret,id=aikayun-trusted-license-config,required=false \
  AIKAYUN_RELEASE_ID="$AIKAYUN_RELEASE_ID" \
  AIKAYUN_RELEASE_VERSION="$AIKAYUN_RELEASE_VERSION" \
  AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64="$(if [ -f /run/secrets/aikayun-trusted-license-config ]; then base64 -w0 /run/secrets/aikayun-trusted-license-config; fi)" \
  AIKAYUN_REQUIRE_LICENSE_CONFIG="$AIKAYUN_REQUIRE_LICENSE_CONFIG" \
  AIKAYUN_PRODUCTION_LICENSE_ISSUER="$AIKAYUN_PRODUCTION_LICENSE_ISSUER" \
  AIKAYUN_PRODUCTION_LICENSE_ROOT_KID="$AIKAYUN_PRODUCTION_LICENSE_ROOT_KID" \
  node apps/api/scripts/prepare-release-build.mjs \
  && pnpm --filter @aikayun/contracts build \
  && pnpm --filter @aikayun/money build \
  && pnpm --filter @aikayun/api build:release \
  && node apps/api/scripts/create-migration-checksums.mjs apps/api/dist/db/migrations \
  && pnpm --filter @aikayun/api deploy --prod /prod/api
RUN node scripts/release/prune-node-modules.mjs /prod/api/node_modules
RUN rm -rf /prod/api/src /prod/api/test /prod/api/scripts \
  && find /prod/api -maxdepth 1 -type f \( -name 'vitest*.config.*' -o -name 'tsconfig*.json' -o -name 'eslint.config.*' \) -delete \
  && find /prod/api/node_modules -type f -name '*.ts' -delete \
  && find /prod/api -type f \( -name '*.map' -o -name '*.d.ts' -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'CONTRIBUTING*' \) -delete
RUN if find /prod/api -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.ts' \) -print -quit | grep -q .; then \
    echo 'Production API tree still contains source or sourcemaps' >&2; \
    find /prod/api -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.ts' \) -print | head -50; \
    exit 1; \
  fi
RUN mkdir -p /runtime-root/var/lib/aikayun/media /runtime-root/var/lib/aikayun/private-files \
    /runtime-root/var/lib/aikayun/identity /runtime-root/var/lib/aikayun/license-trust \
    /runtime-root/var/lib/aikayun/license-pending \
  && chown -R 1000:1000 /runtime-root/var/lib/aikayun \
  && chmod 700 /runtime-root/var/lib/aikayun/private-files /runtime-root/var/lib/aikayun/identity \
    /runtime-root/var/lib/aikayun/license-trust /runtime-root/var/lib/aikayun/license-pending
RUN test "$(dpkg-query -W -f='${Version}' util-linux)" = '2.41.5-0+deb13u1' \
  && install -D -m 0755 /usr/bin/flock /runtime-root/usr/bin/flock \
  && install -D -m 0644 /usr/share/doc/util-linux/copyright /runtime-root/usr/share/doc/util-linux/copyright

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime

ARG AIKAYUN_RELEASE_ID=local-development
ARG AIKAYUN_RELEASE_VERSION=0.0.0-dev
ARG AIKAYUN_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="AiKayun API" \
  org.opencontainers.image.version="$AIKAYUN_RELEASE_VERSION" \
  org.opencontainers.image.revision="$AIKAYUN_SOURCE_COMMIT" \
  io.aikayun.release.id="$AIKAYUN_RELEASE_ID"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /runtime-root/var/lib/aikayun/ /var/lib/aikayun/
COPY --from=build --chown=1000:1000 /prod/api/package.json ./package.json
COPY --from=build --chown=1000:1000 /prod/api/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /prod/api/dist ./dist
COPY --from=build /runtime-root/usr/ /usr/
USER 1000:1000
EXPOSE 3001
CMD ["dist/index.js"]
