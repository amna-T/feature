import assert from "node:assert/strict";
import test from "node:test";
import { bahrainBusinessDate, groupCardNumber, untilBahrainMidnight } from "./utils/helpers.js";

test("card numbers are grouped in fours and capped at 19 digits", () => {
  assert.equal(groupCardNumber("4242424242424242"), "4242 4242 4242 4242");
  assert.equal(groupCardNumber("4242-4242 42"), "4242 4242 42");
  assert.equal(groupCardNumber("12345678901234567890123"), "1234 5678 9012 3456 789");
  assert.equal(groupCardNumber("abc"), "");
});

test("the business-day countdown runs to Asia/Bahrain midnight, not UTC", () => {
  // 20:30 UTC is 23:30 in Bahrain: 30 minutes left, and still the same Bahrain date.
  assert.deepEqual(untilBahrainMidnight(new Date("2026-10-30T20:30:00Z")), { hours: 0, minutes: 30 });
  assert.equal(bahrainBusinessDate(new Date("2026-10-30T20:30:00Z")), "2026-10-30");
  // 21:00 UTC is Bahrain midnight: a new business day with 24 h to go.
  assert.deepEqual(untilBahrainMidnight(new Date("2026-10-30T21:00:00Z")), { hours: 24, minutes: 0 });
  assert.equal(bahrainBusinessDate(new Date("2026-10-30T21:00:00Z")), "2026-10-31");
  assert.deepEqual(untilBahrainMidnight(new Date("2026-10-30T09:15:30Z")), { hours: 11, minutes: 45 });
});
