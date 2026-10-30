import assert from "node:assert/strict";
import test from "node:test";
import { roleGateDecision } from "./auth/roleGate.js";
import { parseBhdInput } from "./format.js";

test("amount inputs take BHD, not fils", () => {
  assert.equal(parseBhdInput("5"), 5_000, "5 means 5 BHD, not 5 fils");
  assert.equal(parseBhdInput("4.75"), 4_750);
  assert.equal(parseBhdInput("4.750"), 4_750);
  assert.equal(parseBhdInput(" 0.001 "), 1);
  for (const bad of ["", "0", "-1", "1.2345", "abc", "1,5"]) {
    assert.equal(parseBhdInput(bad), null, bad);
  }
});

test("the role gate shows nothing until the role is known, then only to allowed roles", () => {
  assert.equal(roleGateDecision(null, ["owner", "finance"]), "loading");
  assert.equal(roleGateDecision({ role: "support" }, ["owner", "finance"]), "denied");
  assert.equal(roleGateDecision({ role: "finance" }, ["owner", "finance"]), "allowed");
});
