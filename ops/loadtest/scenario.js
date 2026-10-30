// Fixed capacity scenario: how many simulated users the stack serves.
//
//   docker run --rm --network <compose network> -v "$PWD/ops/loadtest:/scripts" \
//     -e BASE_URL=http://api:3000 -e API_KEY=fp_... -e USERS=400 \
//     grafana/k6:0.52.0 run /scripts/scenario.js
//
// The scenario is fixed; only USERS changes between runs. See README.md
// ("Fixed scenario") for the definition and the pass criteria. A run passes
// when every threshold below holds; the largest USERS that passes is the
// capacity figure.
import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://api:3000";
const API_KEY = __ENV.API_KEY;
const USERS = Number(__ENV.USERS || 400);
const HOLD = __ENV.HOLD || "3m";

// Fixed scenario parameters. Changing any of these makes results
// incomparable with earlier runs.
const SHOPPER_PACE_S = 30; // each shopper starts one checkout every 30 s
const MERCHANT_PACE_S = 10; // each merchant user refreshes the list every 10 s
const SHOPPERS_PER_MERCHANT = 10; // 1 merchant dashboard user per 10 shoppers
const AMOUNT_FILS = 4750; // 4.750 BD
const RAMP = "1m";

const MERCHANTS = Math.max(1, Math.round(USERS / SHOPPERS_PER_MERCHANT));
const SHOPPERS = USERS - MERCHANTS;

const checkoutsOk = new Counter("checkouts_ok");
const checkoutTime = new Trend("checkout_ms", true);
const shedRate = new Rate("checkout_shed"); // turned away with 503 overloaded
const errorRate = new Rate("checkout_failed"); // any other failure
const listTime = new Trend("list_ms", true);

export const options = {
  scenarios: {
    shoppers: {
      executor: "ramping-vus",
      exec: "shopper",
      startVUs: 0,
      stages: [
        { target: SHOPPERS, duration: RAMP },
        { target: SHOPPERS, duration: HOLD },
      ],
      gracefulRampDown: "10s",
      gracefulStop: "10s",
    },
    merchants: {
      executor: "ramping-vus",
      exec: "merchant",
      startVUs: 0,
      stages: [
        { target: MERCHANTS, duration: RAMP },
        { target: MERCHANTS, duration: HOLD },
      ],
      gracefulRampDown: "10s",
      gracefulStop: "10s",
    },
  },
  // Pass criteria. The ramp minute is excluded by tagging (see `phase`).
  thresholds: {
    "checkout_ms{phase:hold}": ["p(95)<1000"],
    "checkout_shed{phase:hold}": ["rate<0.01"],
    // The acquirer simulator fails ~2% of calls on purpose, two calls per
    // checkout, so ~4% is the floor; 6% leaves room for noise only.
    "checkout_failed{phase:hold}": ["rate<0.06"],
    "list_ms{phase:hold}": ["p(95)<500"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const RAMP_S = 60;

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function phase() {
  return exec.instance.currentTestRunDuration / 1000 < RAMP_S ? "ramp" : "hold";
}

function headers() {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

// Spread users across the pace window so they don't all fire together.
function staggerFirst(pace) {
  if (exec.vu.iterationInScenario === 0) sleep(Math.random() * pace);
}

function paceTo(started, pace) {
  const left = pace - (Date.now() - started) / 1000;
  if (left > 0) sleep(left);
}

// Shopper: pays once (authorize, then capture), then waits for the next one.
export function shopper() {
  staggerFirst(SHOPPER_PACE_S);
  const started = Date.now();
  const tags = { phase: phase() };

  const auth = http.post(
    `${BASE_URL}/v1/transactions`,
    JSON.stringify({ amountFils: AMOUNT_FILS, card: CARD, reference: "k6-scenario" }),
    { headers: Object.assign({ "Idempotency-Key": uuid() }, headers()), tags: { step: "authorize" } },
  );
  let ok = false;
  let shed = auth.status === 503;
  if (auth.status === 201) {
    const cap = http.post(`${BASE_URL}/v1/transactions/${auth.json("id")}/capture`, "{}", {
      headers: Object.assign({ "Idempotency-Key": uuid() }, headers()),
      tags: { step: "capture" },
    });
    shed = cap.status === 503;
    ok = check(cap, { "capture 200": (r) => r.status === 200 });
  } else if (!shed) {
    check(auth, { "authorize 201": (r) => r.status === 201 });
  }

  shedRate.add(shed, tags);
  errorRate.add(!ok && !shed, tags);
  if (ok) {
    checkoutsOk.add(1, tags);
    checkoutTime.add(Date.now() - started, tags);
  }
  paceTo(started, SHOPPER_PACE_S);
}

// Merchant: dashboard open on the transactions list, refreshing.
export function merchant() {
  staggerFirst(MERCHANT_PACE_S);
  const started = Date.now();
  const res = http.get(`${BASE_URL}/v1/transactions?limit=50`, {
    headers: headers(),
    tags: { step: "list" },
  });
  if (check(res, { "list 200": (r) => r.status === 200 })) {
    listTime.add(res.timings.duration, { phase: phase() });
  }
  paceTo(started, MERCHANT_PACE_S);
}
