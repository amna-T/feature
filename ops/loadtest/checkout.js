// Checkout capacity test: authorize then capture, the path every sale takes.
//
//   docker run --rm --network <compose network> -v "$PWD/ops/loadtest:/scripts" \
//     -e BASE_URL=http://api:3000 -e API_KEY=fp_... grafana/k6:0.52.0 run /scripts/checkout.js
//
// Arrival rate steps up every 30 s, so the result shows where the API stops
// keeping up. Over capacity the API answers 503 `overloaded` at once (load
// shedding); those are counted apart from real errors.
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://api:3000";
const API_KEY = __ENV.API_KEY;
const STEPS = (__ENV.STEPS || "5,10,15,20,30").split(",").map(Number);

const checkouts = new Counter("checkouts_ok");
const shed = new Counter("shed_503");
const failures = new Counter("checkout_errors");
const checkoutTime = new Trend("checkout_ms", true);

export const options = {
  scenarios: {
    checkout: {
      executor: "ramping-arrival-rate",
      startRate: STEPS[0],
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: STEPS.flatMap((rate) => [
        { target: rate, duration: "5s" },
        { target: rate, duration: "25s" },
      ]),
    },
  },
};

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  const started = Date.now();

  const auth = http.post(
    `${BASE_URL}/v1/transactions`,
    JSON.stringify({ amountFils: 4750, card: CARD, reference: "k6" }),
    { headers: Object.assign({ "Idempotency-Key": uuid() }, headers), tags: { step: "authorize" } },
  );
  if (auth.status === 503) return shed.add(1);
  if (!check(auth, { "authorize 201": (r) => r.status === 201 })) return failures.add(1);

  const id = auth.json("id");
  const cap = http.post(`${BASE_URL}/v1/transactions/${id}/capture`, "{}", {
    headers: Object.assign({ "Idempotency-Key": uuid() }, headers),
    tags: { step: "capture" },
  });
  if (cap.status === 503) return shed.add(1);
  if (!check(cap, { "capture 200": (r) => r.status === 200 })) return failures.add(1);

  checkouts.add(1);
  checkoutTime.add(Date.now() - started);
}
