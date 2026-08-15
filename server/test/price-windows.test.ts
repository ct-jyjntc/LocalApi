import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPriceWindows,
  clockToMinutes,
  findActiveWindowIndex,
  minutesInWindow,
  normalizeClock,
  parsePriceWindows,
} from "../src/services/price-windows";

test("normalizeClock accepts HH:MM and 24:00", () => {
  assert.equal(normalizeClock("8:00"), "08:00");
  assert.equal(normalizeClock("08:00:00"), "08:00");
  assert.equal(normalizeClock("24:00"), "24:00");
  assert.equal(normalizeClock("24:01"), null);
  assert.equal(normalizeClock("25:00"), null);
});

test("minutesInWindow handles daytime and overnight ranges", () => {
  assert.equal(minutesInWindow(10 * 60, 8 * 60, 22 * 60), true);
  assert.equal(minutesInWindow(7 * 60, 8 * 60, 22 * 60), false);
  assert.equal(minutesInWindow(23 * 60, 22 * 60, 8 * 60), true);
  assert.equal(minutesInWindow(3 * 60, 22 * 60, 8 * 60), true);
  assert.equal(minutesInWindow(12 * 60, 22 * 60, 8 * 60), false);
  assert.equal(minutesInWindow(0, 0, 1440), true);
  assert.equal(clockToMinutes("24:00"), 1440);
});

test("parsePriceWindows drops invalid rows and caps the list", () => {
  const windows = parsePriceWindows([
    { start: "08:00", end: "08:00", input_price_micros: 1, output_price_micros: 1 },
    { start: "08:00", end: "22:00", input_price_micros: 2, output_price_micros: 3, days: [1, 1, 8, 2] },
    { start: "bad", end: "22:00", input_price_micros: 1, output_price_micros: 1 },
  ]);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].days, [1, 2]);
  assert.equal(windows[0].start, "08:00");
});

test("first matching window wins; days filter and default rates apply", () => {
  const price = {
    input_price_micros: 1,
    output_price_micros: 2,
    cache_read_price_micros: 3,
    cache_write_price_micros: 4,
    windows: parsePriceWindows([
      { start: "08:00", end: "22:00", days: [1], input_price_micros: 10, output_price_micros: 20, cache_read_price_micros: 30, cache_write_price_micros: 40 },
      { start: "08:00", end: "22:00", input_price_micros: 11, output_price_micros: 21, cache_read_price_micros: 31, cache_write_price_micros: 41 },
    ]),
  };
  // Monday 10:00 Shanghai = Sunday 22:00 UTC during CST (UTC+8)
  const mondayMorning = new Date("2026-08-17T02:00:00.000Z");
  const applied = applyPriceWindows(price, mondayMorning);
  assert.equal(applied.active_window_index, 0);
  assert.equal(applied.input_price_micros, 10);

  const tuesdayMorning = new Date("2026-08-18T02:00:00.000Z");
  const second = applyPriceWindows(price, tuesdayMorning);
  assert.equal(second.active_window_index, 1);
  assert.equal(second.input_price_micros, 11);

  const night = new Date("2026-08-17T16:00:00.000Z"); // Monday 00:00 Shanghai
  const fallback = applyPriceWindows(price, night);
  assert.equal(fallback.active_window_index, null);
  assert.equal(fallback.input_price_micros, 1);
  assert.equal(findActiveWindowIndex([], night), null);
});
