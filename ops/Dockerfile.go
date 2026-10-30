# Image for apps/settlement. Build from the repo root:
#   docker build -f ops/Dockerfile.go -t filspay-settlement .
#
# Multi-stage: the Go toolchain and build cache stay in the build stage, so
# the box doesn't fill its disk with them (ops/README: "first build on the
# box filled the disk"). The binary is static (CGO off) and embeds the time
# zone data it needs (cmd/settlement imports time/tzdata), so it runs on a
# minimal non-root base.

FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/settlement ./settlement
EXPOSE 8091
CMD ["./settlement", "daemon"]
