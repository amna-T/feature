# Checkout capacity

The API handles about **15 checkouts per second** (authorize + capture) with
the compose defaults (`PG_POOL_MAX=10`) inside its 0.5 vCPU / 512 MB container.
Past capacity it turns requests away at once with `503 overloaded` and
`Retry-After: 1` instead of queueing; memory stays under 70 MB.

Measured on 30 Oct 2026 with `checkout.js` (k6 0.52) against the compose stack,
API container limited to `cpus: 0.5`, `mem_limit: 512m`. Each run holds the
offered rate for 25 s after a 5 s ramp. The acquirer simulator adds 100–400 ms
per call and fails about 2% of calls (the "errors" column).

| `PG_POOL_MAX` | Offered (checkouts/s) | Completed/s | p50 | p95 | Shed (503) | Errors |
|---|---|---|---|---|---|---|
| 5 | 6 | 5.6 | 578 ms | 758 ms | 0 | 7 |
| 5 | 8 | 7.4 | 574 ms | 1.18 s | 0 | 14 |
| 5 | 5 → 30 (stepped) | 7.1 avg | 1.84 s | 2.54 s | 1,224 | 44 |
| 10 | 12 | 11.3 | 591 ms | 1.45 s | 1 | 13 |
| 10 | 16 | 14.9 | 618 ms | 1.28 s | 4 | 22 |
| 20 | 24 | 20.8 | 709 ms | 1.93 s | 63 | 22 |
| 20 | 32 | 27.5 | 685 ms | 1.67 s | 89 | 27 |

Peak API memory across all runs: 60 MB. No restarts or OOM kills.

## Hosted box (Dilmune, 1 vCPU / 2 GB), 30 Oct 2026

Measured on the live server through Caddy over HTTPS
(`BASE_URL=https://168.144.75.125`), with `PG_POOL_MAX=10`, a dedicated load-test
merchant, and k6 running **on the same 1 vCPU box** (so these figures are, if
anything, conservative). Each step: 5 s ramp, 25 s hold.

| Run | Offered (checkouts/s) | Completed | Checkout p50 / p95 | Request p95 | Shed (503) | Errors |
|---|---|---|---|---|---|---|
| 1 | 2, 4, 6, 8, 10, 14 | kept up at every step (7.1/s avg = offered avg) | 568 ms / 824 ms | 434 ms | 0 | 55 of 1,289 (4.3%) |
| 2 | 14, 17, 20, 25, 30 | **14.5/s plateau** | 1.17 s / 1.69 s | 931 ms | 836 | 117 of 2,303 (5.1%) |

- **Capacity: 14 checkouts/s sustained with p95 under 1 s; ceiling about 15/s.**
  The bottleneck is the API's database pool (each checkout holds a connection
  for ~0.3 s per acquirer call), not CPU or memory.
- Past the ceiling the API answers `503 overloaded` + `Retry-After: 1` at once;
  latency stays bounded (max 2.4 s) instead of queueing.
- "Errors" are the simulator's deliberate ~2% failure per acquirer call (two
  calls per checkout), not server faults.
- No restarts of api, postgres or proxy during either run.
- Under overload some captures are shed after their authorize succeeded
  (278 in run 2). Those holds are never charged; they expire and are released
  by `scripts/expire_holds.ts`, and a client retrying the capture with the same
  Idempotency-Key completes it.

To repeat it: create a load-test merchant and key (see the submission
document), then
`docker run --rm --network host -v "$PWD/ops/loadtest:/scripts" -e BASE_URL=https://<site> -e API_KEY=... -e K6_INSECURE_SKIP_TLS_VERIFY=true -e STEPS=14,17,20,25,30 grafana/k6:0.52.0 run /scripts/checkout.js`.

## What limits capacity

Authorize and capture each hold a database connection for the whole acquirer
call (~250 ms on average), so checkout throughput is roughly
`PG_POOL_MAX / 2 calls / 0.3 s`. CPU was not the limit at these rates.

**Caveat:** Postgres was not CPU-limited in this run. On the hosted box every
container shares 0.5 vCPU, so expect lower figures there; re-run on the box
before quoting a number. Raise `PG_POOL_MAX` only together with Postgres
`max_connections` (40 in compose).

## Running it

```bash
# 1. Stack up (see ops/README.md), then a merchant with an API key.
# 2. From the repo root:
docker run --rm --network filspay-hosting_default -v "$PWD/ops/loadtest:/scripts" \
  -e BASE_URL=http://api:3000 -e API_KEY=fp_... -e STEPS=5,10,15,20,30 \
  grafana/k6:0.52.0 run /scripts/checkout.js
```

`STEPS` is a comma-separated list of arrival rates, 30 s each. Run against
`http://api:3000` to measure the API; through `https://proxy` adds TLS.

## Restart safety

`restart: unless-stopped` brings the API back after it exits or is OOM-killed
(checked: process exit, back healthy in ~15 s). A request cut off mid-checkout
is safe to retry with the same `Idempotency-Key`, and outbox events are written
in the same transaction as the money movement. `docker kill` and
`docker stop` count as manual stops, so Docker does not restart those.
