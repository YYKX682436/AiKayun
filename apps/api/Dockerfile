# Build the fixed Restic reader and the authenticated host helper into separate
# release stages; the API release stage includes the latter only.
FROM --platform=$BUILDPLATFORM golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS restic-build
ARG TARGETOS
ARG TARGETARCH
COPY scripts/release/restic-build/make-module.py scripts/release/restic-build/go.mod.lock scripts/release/restic-build/go.sum.lock /input/
WORKDIR /tmp
RUN go mod download -json github.com/restic/restic@v0.19.1 > /tmp/upstream.json \
  && python3 -c 'import json; j=json.load(open("/tmp/upstream.json")); assert j["Sum"] == "h1:LQKkar5/gYxay1OCokAWPBNiLr1lTpt4fhdM4GWqSlY="; assert j["Origin"]["Hash"] == "6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf"' \
  && python3 /input/make-module.py /go/pkg/mod/cache/download/github.com/restic/restic/@v/v0.19.1.zip /input/go.mod.lock /input/go.sum.lock /proxy
RUN test "$TARGETOS" = linux && { test "$TARGETARCH" = amd64 || test "$TARGETARCH" = arm64; } \
  && GOPROXY=file:///proxy,https://proxy.golang.org GONOSUMDB=github.com/restic/restic \
     GOOS="$TARGETOS" GOARCH="$TARGETARCH" CGO_ENABLED=0 \
     go install -trimpath -tags=disable_grpc_modules -ldflags='-s -w' github.com/restic/restic/cmd/restic@v0.19.1-aikayun.3 \
  && (cd /go/pkg/mod/github.com/restic/restic@v0.19.1-aikayun.3 && go mod verify) \
  && if test "$TARGETARCH" = "$(go env GOHOSTARCH)"; then binary=/go/bin/restic; else binary="/go/bin/${TARGETOS}_${TARGETARCH}/restic"; fi \
  && mkdir /out && cp "$binary" /out/restic \
  && go version -m /out/restic > /out/buildinfo \
  && grep -F 'mod' /out/buildinfo | grep -F 'github.com/restic/restic' | grep -F 'v0.19.1-aikayun.3' | grep -F 'h1:nG3bsvusX28+p0A8fkwIgBWKgkbBJO/Etl95a8zWiOM=' \
  && grep -Fx "$(printf '\tbuild\tGOARCH=%s' "$TARGETARCH")" /out/buildinfo \
  && grep -Fx '/out/restic: go1.27.3' /out/buildinfo

FROM scratch AS restic-artifact
COPY --from=restic-build /out/restic /restic

# Private, explicit build output used only to prepare license evidence. Its
# module ZIPs are independently checked against the built binary's Go h1s.
FROM --platform=$BUILDPLATFORM golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS restic-collector-build
WORKDIR /collector-src
COPY scripts/release/restic-build/license-collector/go.mod scripts/release/restic-build/license-collector/go.sum scripts/release/restic-build/license-collector/main.go ./
RUN go build -mod=readonly -trimpath -o /collector .

FROM scratch AS restic-evidence
COPY --from=restic-build /out/restic /restic
COPY --from=restic-build /go/pkg/mod/cache/download/ /module-cache/cache/download/
COPY --from=restic-collector-build /collector /collector

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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS runtime

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

# Runtime image for the isolated backup reader. It contains only the verified
# static Restic binary and the public CA bundle needed for HTTPS repositories.
# The container reads caller-mounted sources and repository paths; it has no
# Docker socket, shell, package manager, tar implementation, or network access
# unless the caller explicitly enables a repository network.
FROM scratch AS restic-runtime
ARG AIKAYUN_RELEASE_ID=local-development
ARG AIKAYUN_RELEASE_VERSION=0.0.0-dev
ARG AIKAYUN_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="AiKayun Restic Backup Reader" \
  org.opencontainers.image.version="$AIKAYUN_RELEASE_VERSION" \
  org.opencontainers.image.revision="$AIKAYUN_SOURCE_COMMIT" \
  io.aikayun.release.id="$AIKAYUN_RELEASE_ID"
COPY --from=restic-build --chmod=0555 /out/restic /usr/bin/restic
COPY --from=restic-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=restic-build /usr/share/doc/ca-certificates/copyright /usr/share/doc/ca-certificates/copyright
USER 0:0
ENTRYPOINT ["/usr/bin/restic"]

# Keep the production API as the default release target. Container management
# runs in the signed host utility, outside this image.
FROM runtime AS release
