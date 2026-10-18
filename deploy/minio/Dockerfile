# MinIO's public container repositories are no longer pullable. Build the
# official sources for CI and development; production uses AWS S3.
FROM golang:1.26.9-alpine AS build

# RELEASE.2025-10-15T17-29-55Z (server) and RELEASE.2025-08-13T08-35-41Z (client).
# Pseudo-versions pin the upstream commits and are verified by Go's checksum DB.
ARG MINIO_VERSION=v0.0.0-20251015172955-9e49d5e7a648
ARG MC_VERSION=v0.0.0-20250813083541-7394ce0dd2a8
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN go install -p 4 -trimpath -ldflags="-s -w" github.com/minio/minio@${MINIO_VERSION} \
    && go install -p 4 -trimpath -ldflags="-s -w" github.com/minio/mc@${MC_VERSION} \
    && mkdir -p /licenses/minio /licenses/mc \
    && cp /go/pkg/mod/github.com/minio/minio@${MINIO_VERSION}/LICENSE /licenses/minio/ \
    && cp /go/pkg/mod/github.com/minio/mc@${MC_VERSION}/LICENSE /licenses/mc/ \
    && go clean -cache -modcache

FROM alpine:3.23
RUN apk add --no-cache ca-certificates curl
COPY --from=build /go/bin/minio /go/bin/mc /usr/local/bin/
COPY --from=build /licenses /licenses
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
