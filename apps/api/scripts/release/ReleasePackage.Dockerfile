FROM scratch
ARG AIKAYUN_RELEASE_ID
ARG AIKAYUN_RELEASE_VERSION
ARG AIKAYUN_SOURCE_COMMIT
LABEL org.opencontainers.image.title="AiKayun signed release bundle" \
  org.opencontainers.image.version="$AIKAYUN_RELEASE_VERSION" \
  org.opencontainers.image.revision="$AIKAYUN_SOURCE_COMMIT" \
  org.opencontainers.image.source="https://github.com/YYKX682436/AiKayun"
COPY . /release/
