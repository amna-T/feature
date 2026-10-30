import type { SimulatedCardInput } from "../acquirer/types.js";
import { BadRequestError } from "../lib/errors.js";

/**
 * Validates card input from a request body before anything is reserved or
 * claimed. Nothing checked it: a body like `{ "card": {} }` crashed inside
 * the acquirer call with a 500, and on the public checkout that left the
 * payment link stuck 'reserved', so anyone with a link could keep it
 * unpayable. Expiry wasn't checked either, so an expired card was charged.
 *
 * The card number may be typed with spaces or dashes; it is passed on as
 * digits only.
 */
export function parseCardInput(raw: unknown, now: Date = new Date()): SimulatedCardInput {
  if (typeof raw !== "object" || raw === null) {
    throw new BadRequestError("invalid_card", "Enter your card details.");
  }
  const card = raw as Record<string, unknown>;

  const pan = typeof card.pan === "string" ? card.pan.replace(/[\s-]/g, "") : "";
  if (!/^\d{12,19}$/.test(pan)) {
    throw new BadRequestError("invalid_card", "Enter a valid card number.");
  }
  const { expiryMonth, expiryYear } = card;
  if (!Number.isInteger(expiryMonth) || (expiryMonth as number) < 1 || (expiryMonth as number) > 12) {
    throw new BadRequestError("invalid_card", "Enter a valid expiry month.");
  }
  if (!Number.isInteger(expiryYear) || (expiryYear as number) < 2000 || (expiryYear as number) > 2100) {
    throw new BadRequestError("invalid_card", "Enter a valid expiry year.");
  }
  // A card is valid through the last day of its expiry month (Bahrain time).
  const bahrain = new Date(now.getTime() + 3 * 3_600_000);
  const thisMonth = bahrain.getUTCFullYear() * 12 + bahrain.getUTCMonth();
  if ((expiryYear as number) * 12 + ((expiryMonth as number) - 1) < thisMonth) {
    throw new BadRequestError("card_expired", "This card has expired.");
  }
  if (typeof card.cvv !== "string" || !/^\d{3,4}$/.test(card.cvv)) {
    throw new BadRequestError("invalid_card", "Enter the 3 or 4 digit security code.");
  }
  return { pan, expiryMonth: expiryMonth as number, expiryYear: expiryYear as number, cvv: card.cvv };
}
