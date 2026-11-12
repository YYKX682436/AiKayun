# Internal build artifact only. This is not a production image or release entry point.
FROM --platform=$BUILDPLATFORM golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS build
ARG TARGETOS
ARG TARGETARCH
COPY make-module.py go.mod.lock go.sum.lock /input/
WORKDIR /tmp
# First authenticate the actual upstream module against the public Go checksum
# database. The local proxy contains only the distinctly named patched module.
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

FROM scratch AS artifact
COPY --from=build /out/restic /restic
ENTRYPOINT ["/restic"]
