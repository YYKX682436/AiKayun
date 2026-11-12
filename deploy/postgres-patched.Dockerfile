# Apply the upstream Alpine fix for CVE-2026-125350 until the official image is rebuilt.
FROM docker.io/library/postgres@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395
RUN apk add --no-cache --upgrade 'libxslt=1.1.43-r4' 'zlib=1.4-r0'
