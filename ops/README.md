# ops/

The FilsPay stack: Postgres, apps/api behind a TLS reverse proxy (Caddy),
apps/settlement and apps/reporting. The hosted demo box (0.5 vCPU / 2 GB RAM /
2 GB disk) runs this same compose file.

## Quick start

Run from the repo root. api and settlement refuse to start without two
secrets; export them first (or put them in `ops/.env`):

```
cp ops/.env.docker.example ops/.env.docker   # gitignored; then set its secret:
sed -i "s/^ACQUIRER_CALLBACK_SIGNING_SECRET=.*/ACQUIRER_CALLBACK_SIGNING_SECRET=$(openssl rand -hex 32)/" ops/.env.docker
export SETTLEMENT_INTERNAL_TOKEN=$(openssl rand -hex 24)
export WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
export SITE_ADDRESS=localhost        # the public host name on the hosted box

docker compose -f ops/docker-compose.yml up -d --build postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml up -d --build proxy api settlement reporting
curl -k https://localhost/healthz
```

**Hosted demo logins.** There is no email/SMS delivery for login codes, so
on a demo box set `OTP_DEV_EXPOSE=true` in `ops/.env.docker` (the code then
appears on the login page). The seeded passwords are public in the repo, so
after seeding replace them:

```
docker compose -f ops/docker-compose.yml run --rm \
  -e MERCHANT_PASSWORD='<12+ chars>' -e ADMIN_PASSWORD='<12+ chars, different>' \
  migrate npx tsx scripts/set_passwords.ts
```

`seed` (`docker compose ... run --rm seed`) wipes and regenerates fixture
data. It is for local use only and refuses `NODE_ENV=production`.

The proxy image (`Dockerfile.proxy`) has both frontends built in:

| Address | What |
|---|---|
| `https://SITE_ADDRESS/` | merchant dashboard; checkout at `/pay/<token>` |
| `https://SITE_ADDRESS:8443/` | admin console |

Both proxy `/v1`, `/healthz` and `/readyz` to the API, so the apps call it on
their own origin (the API has no CORS). For local development the apps still
run with `npm run dev` inside each package.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack, with resource limits, restarts and health checks |
| `Caddyfile` | TLS, the two frontends as static files, and the API behind them (`SITE_ADDRESS`) |
| `Dockerfile.proxy` | builds apps/web and apps/admin and bakes them into the Caddy image |
| `Dockerfile.node` | api and reporting (`runtime` target: production deps + `dist/` bundles), migrate and seed (`tools` target) |
| `Dockerfile.go` | multi-stage, static build of `apps/settlement` on a distroless non-root base |
| `build.mjs` | `npm run build`: bundles api and reporting to `dist/` with esbuild |
| `loadtest/` | k6 checkout capacity test and the measured results |
| `.env.docker.example` | template for `.env.docker` (shared service settings, loaded with `env_file:`). The real file is gitignored: it used to be committed with the callback signing secret, so that old value is burned |

## What compose sets up for hosting

| Concern | Setting |
|---|---|
| Exposure | Only Caddy publishes on all interfaces (80, 443, and 8443 for the admin console). The API is on `127.0.0.1:3000`, Postgres on `127.0.0.1:5432` |
| Client IP | Caddy is one hop, so the API runs with `TRUST_PROXY=1`. Without a proxy leave it unset, or X-Forwarded-For could be spoofed to dodge per-IP login limits |
| API limits | `cpus: 0.5`, `mem_limit: 512m`, `NODE_OPTIONS=--max-old-space-size=384` so Node collects garbage before the container is killed |
| Other limits | Postgres 768 MB (`shared_buffers=192MB`), settlement and reporting 256 MB, Caddy 128 MB |
| Recovery | `restart: unless-stopped` on every long-running service; API health check on `/healthz` |
| Overload | Over capacity the API answers `503 overloaded` + `Retry-After` at once (`LOAD_SHED_MAX_WAITING`, default 20 waiting requests) |
| Logging | `LOG_LEVEL=warn`: per-request info logs cost real CPU on 0.5 vCPU |
| Start-up | The API and reporting run prebuilt JavaScript (`node dist/...`), not `npx tsx` |

Capacity measured with these settings: about 15 checkouts per second with
`PG_POOL_MAX=10`. See `loadtest/README.md`, including the caveat about CPU on
the hosted box.

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
`sslmode=disable` is acceptable because Postgres and every service share the
compose bridge network on one host. A separate, limited role for the API is
still to do.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. It only takes effect when
`DATABASE_URL` is unset.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL`, `TRUST_PROXY`, `LOG_LEVEL`, `PG_POOL_MAX` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY`, `SETTLEMENT_INTERNAL_TOKEN` | shell (required) |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET`, `NODE_ENV` | `.env.docker` |
| settlement | `DATABASE_URL` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | shell (required) |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |
| proxy | `SITE_ADDRESS` | shell, default `localhost` |

## Disk

The Go toolchain and its build cache stay in the build stage of
`Dockerfile.go`, so building on the 2 GB box no longer fills the disk with
them. Run `docker builder prune` after a build if space is tight.
