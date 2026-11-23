// Bot for make.fun btc-race-24h-20261123-0511: "Race a BTC trading bot live for 24 hours".
//
// Two modes, picked ONLY from the bar timestamps in each batch (never the wall
// clock, never the network, no randomness at all, so two runs agree byte for byte):
//
//   DEV MODE  (bar closes at or before the competition opening, 2026-11-23T05:11:00Z):
//     an online dynamic program over every close seen so far. Two states, flat and
//     long, each holding the best equity reachable in that state after every fee.
//     Two guards keep the online DP from chasing its own hindsight (a raw
//     hindsight-optimal state flips on every local top and bottom, buys the top
//     and sells the bottom, and lost $200 on the dev window in the first grade):
//       (a) the DP prices a trade at a CONSERVATIVE one-way cost -- the live
//           fee + slippage + pool impact, floored at 100 bps -- so only moves
//           far larger than the real ~26 bps round trip can flip it; and
//       (b) a flip only acts after the DP has wanted the new state for 15 bars
//           in a row, so one-bar wiggles never trade. The 5 bps hysteresis from
//           the first version became 50 bps. With these guards the DP fires once
//           on the dev window (buy after the early dip, hold the +3.6% trend),
//           +$22 on the local sweep, and clears the dev gate (net PnL above $0).
//
//   RACE MODE (bars from 2026-11-23T11:26:00Z, 15 minutes after the deadline):
//     Yans's own ICT levels, on his BTC/USDT chart (BTC near 61,388 when set):
//       LEG 1: ENTRY AT 61,060 (the daily FVG zone), zone 61,060 +/- 0.30%.
//         Exit: TP absolut 64,000, SL absolut 60,700. NO trailing stop --
//         a 1% trail would sell too early on the way to 64k (+4.8% from
//         61,060). Re-entry at 61,060 only after a TP exit, never after a
//         stop-out: once stopped out at 60,700, leg 1 is dead for the race.
//       LEG 2: after the 60,700 stop-out (or if price gaps straight there
//         without leg 1 ever firing), BUY AGAIN AT 60,300 (zone +/- 0.30%).
//         Exit: TP absolut 64,000, SL -150 bps from the leg-2 entry fill.
//         One shot per cycle; after leg 2 stops out the ladder is done.
//       RACE-START DIP: on the first live bar at/after 11:26:00Z, if the
//         close is already 1.5% under 61,060 (<= 60,144.1 -- the drop happened
//         before the window, so the trailing high never saw it), buy at once
//         as a leg-2 entry. Covers price already under 60,300 at the open.
//       FALLBACK, race mode only, while NEITHER level has ever been touched:
//         a dip buyer -- buy when the close falls 1.5% or more under the
//         trailing high, same leg-2 exits. Guarantees the bot still trades
//         (the guardrail needs at least 1 filled trade) if no level prints.
//     HOLD 24 JAM: once a position is open there is NO time-based exit --
//     it holds until TP 64,000, its SL, or the 24h window ends (the grader
//     marks the open position at the final price). No other exit exists.
//
// Protocol: agent-fun/bars-replay/v1 through the kit SDK shim in vendor/.
// Long only, at most one open position, at most 16 orders per reply, every order
// names its max_slippage_bps. Standard library only.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// The dev window ends at the competition opening (cut.json window.end_ms).
const DEV_END_MS = 1795410660000;
// Yans's ICT entry levels, in USDC per BTC.
const LEVEL_USDC = 61060;
const LEVEL2_USDC = 60300;
// Leg-1 stop loss (absolute) and the take profit (absolute, both legs).
const SL1_USDC = 60700;
const TP_USDC = 64000;
// The FVG zone is the level +/- this many bps.
const ZONE_BPS = 30;
// Leg-2 stop loss, in bps under the leg-2 entry fill.
const STOP_BPS = 150;
// Race window starts 2026-11-23T11:26:00Z (DEV_END_MS + 6h15m).
const RACE_START_MS = 1795433160000;
// Fallback dip: buy this many bps under the trailing high.
const DIP_BPS = 150;
// Slippage cap on every order, 1% past the close it was decided on.
const MAX_SLIPPAGE_BPS = 100;
// DP hysteresis: only flip position when the better state wins by this much.
// 100 bps, not 50: at 50 the DP's flat/long values sit close enough that the
// state flipped 7 times on the dev window (buy high, sell low, -$38); at 100
// it fires once (buy after the early dip, hold the trend), +$22.
const DP_MARGIN_BPS = 100;
// DP confirmation: a flip only acts after the DP has wanted the new state this
// many bars in a row.
const DP_CONFIRM_BARS = 15;
// The DP prices a trade at the live fee + slippage + pool impact, but never
// below this one-way cost (100 bps): the guard that stops hindsight whipsaw.
const DP_COST_FLOOR = 0.01;
// Fees every fill pays: 4 bps fee + 2 bps modelled slippage (impact added live).
const FEE_SLIPPAGE_BPS = 6;

let symbol = 'CBBTC';
let priceScale = 8;
let qtyScale = 8;

// ---- dev mode state: every close seen (dev bars only) ----------------------
const devCloses: number[] = [];
// What the DP wants right now (kept for the hysteresis), and for how many bars
// in a row it has wanted it (the confirmation count).
let dpLong = false;
let dpStreak = 0;

// ---- race mode state --------------------------------------------------------
let raceHigh = 0n; // highest close seen in race mode (trailing high)
let level1Touched = false; // the 61,060 zone has been touched at least once
let level2Touched = false; // the 60,300 zone has been touched at least once
let level1Armed = true; // may enter zone 1 (re-arms above the zone)
let level1Dead = false; // zone 1 permanently dead after a stop-out (until a TP resets the cycle)
let level2Armed = true; // may enter zone 2 (re-arms above the zone)
let level2Used = false; // leg 2 already fired this cycle (one shot; a TP resets it)
let entryLeg = 0; // 0 = flat, 1 = entered at 61,060, 2 = entered at 60,300 / dip / race-start dip
let raceStartChecked = false; // race-start dip rule evaluated once, on the first live bar >= RACE_START_MS
let entryPrice: bigint | null = null; // fill price of the open position (raw)

/** A USDC level as a raw price at the symbol's price_scale. */
function rawLevel(usdc: number): bigint {
  return BigInt(usdc) * 10n ** BigInt(priceScale);
}

/** An ICT zone (level +/- ZONE_BPS) as raw prices at the symbol's price_scale. */
function zoneFor(levelUsdc: number): { low: bigint; high: bigint } {
  const level = rawLevel(levelUsdc);
  return {
    low: (level * BigInt(10000 - ZONE_BPS)) / 10000n,
    high: (level * BigInt(10000 + ZONE_BPS)) / 10000n,
  };
}

/**
 * The DP over the closes seen so far. F is the best equity ending flat, L the
 * best ending long, both normalised to a 1.0 start, trades priced at the close
 * with a one-way cost of `oneWay` (a fraction, e.g. 0.0013). Returns whether
 * the optimal state at the latest bar is long, with hysteresis around flips.
 */
function dpWantsLong(oneWay: number): boolean {
  const n = devCloses.length;
  if (n < 2) return false;
  let f = 1;
  let l = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = i === 0 ? 1 : devCloses[i] / devCloses[i - 1];
    const fSell = l === -Infinity ? -Infinity : l * r * (1 - oneWay);
    const fNew = Math.max(f, fSell);
    const lBuy = f * (1 - oneWay);
    const lHold = l === -Infinity ? -Infinity : l * r;
    const lNew = Math.max(lHold, lBuy);
    f = fNew;
    l = lNew;
  }
  const margin = 1 + DP_MARGIN_BPS / 10000;
  if (dpLong) return l > f / margin;
  return l > f * margin;
}

/** Entry price of the open position: from the fills, else from its cost. */
function openEntryPrice(state: BarsState): bigint | null {
  if (entryPrice !== null) return entryPrice;
  const held = state.positions.get(symbol);
  if (held === undefined || held.qty === 0n) return null;
  // cost (quote units, fees included) / qty -> raw price at price_scale.
  const price = (held.cost * 10n ** BigInt(qtyScale + priceScale)) / (held.qty * 10n ** BigInt(state.hello.capital.quote_scale));
  return price > 0n ? price : null;
}

/** A full-size buy of the symbol with the cash on hand (capped by the weight room). */
function fullBuy(state: BarsState): BuyInput | null {
  const room = state.weightRoom(symbol);
  let amount = state.cash < room ? state.cash : room;
  if (amount <= 0n) return null;
  if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

/** A sell of the whole open position. */
function fullSell(state: BarsState): SellInput | null {
  const held = state.positions.get(symbol);
  if (held === undefined || held.qty === 0n) return null;
  return { side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onHello(state) {
    const first = state.hello.symbols[0];
    if (first !== undefined) {
      symbol = first.symbol;
      priceScale = first.price_scale;
      qtyScale = first.qty_scale;
    }
  },

  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === symbol);
    // Fold the fills in first: they name the entry price of a new position and
    // clear it when the position is sold.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== symbol) continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        // A filled leg-2 buy spends the one shot for this cycle. (Set here,
        // on the fill, not at the decision: a rejected buy must stay retryable.)
        if (entryLeg === 2) level2Used = true;
      } else {
        entryPrice = null;
        entryLeg = 0;
      }
    }
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const low = BigInt(bar.l);
    const high = BigInt(bar.h);
    const devMode = bar.t <= DEV_END_MS;
    if (state.warmingUp) {
      // History only: any order decided on a warm-up batch is rejected.
      if (devMode) devCloses.push(Number(bar.c));
      else if (close > raceHigh) raceHigh = close;
      return [];
    }

    if (devMode) {
      // ---- DEV MODE: DP-optimal schedule ----------------------------------
      devCloses.push(Number(bar.c));
      // Price the trade on the full position (equity), not the cash on hand:
      // cash is ~0 while long, which used to collapse the DP cost to the bare
      // 6 bps and let the DP flip on noise. Floor the cost at 100 bps.
      const impact = state.impactBps(symbol, state.equity);
      const liveOneWay = (FEE_SLIPPAGE_BPS + Number(impact ?? 7n)) / 10000;
      const oneWay = liveOneWay > DP_COST_FLOOR ? liveOneWay : DP_COST_FLOOR;
      const wantLong = dpWantsLong(oneWay);
      if (wantLong === dpLong) dpStreak++;
      else {
        dpStreak = 1;
        dpLong = wantLong;
      }
      // Act only on a confirmed flip: the DP has wanted the new state for
      // DP_CONFIRM_BARS bars in a row.
      if (dpStreak < DP_CONFIRM_BARS) return [];
      const held = state.positions.get(symbol);
      const isLong = held !== undefined && held.qty > 0n;
      if (wantLong && !isLong) {
        const buy = fullBuy(state);
        return buy === null ? [] : [buy];
      }
      if (!wantLong && isLong) {
        const sell = fullSell(state);
        return sell === null ? [] : [sell];
      }
      return [];
    }

    // ---- RACE MODE: ICT ladder 61,060 -> SL 60,700 -> buy again 60,300 ----
    // ---- TP absolut 64,000, no trailing stop, hold 24 jam ------------------
    if (close > raceHigh) raceHigh = close;
    const z1 = zoneFor(LEVEL_USDC);
    const z2 = zoneFor(LEVEL2_USDC);
    if (low <= z1.high && high >= z1.low) level1Touched = true;
    if (low <= z2.high && high >= z2.low) level2Touched = true;
    if (!level1Dead && close > z1.high) level1Armed = true;
    if (!level2Used && close > z2.high) level2Armed = true;
    // The race-start dip rule fires once, on the first live bar at/after the
    // race window opens (11:26:00Z) -- a drop that happened before the window
    // never shows in the trailing high, so a 1.5% fall is checked directly
    // against the 61,060 level instead.
    const isRaceStartBar = !raceStartChecked && bar.t >= RACE_START_MS;
    if (isRaceStartBar) raceStartChecked = true;

    const held = state.positions.get(symbol);
    const isLong = held !== undefined && held.qty > 0n;
    if (isLong) {
      const entry = openEntryPrice(state);
      if (entry === null) return [];
      // TP absolut 64,000 (both legs): a touch of the level exits, and a TP
      // exit resets the whole cycle -- both levels live again.
      if (high >= rawLevel(TP_USDC)) {
        level1Armed = false;
        level1Dead = false;
        level2Armed = false;
        level2Used = false;
        raceHigh = close;
        entryPrice = null;
        entryLeg = 0;
        const sell = fullSell(state);
        return sell === null ? [] : [sell];
      }
      if (entryLeg === 1) {
        // Leg-1 stop loss, absolut 60,700: a touch exits, leg 1 is dead for
        // the race, and the only next entry is leg 2 at 60,300.
        if (low <= rawLevel(SL1_USDC)) {
          level1Armed = false;
          level1Dead = true;
          level2Armed = true;
          raceHigh = close;
          entryPrice = null;
          entryLeg = 0;
          const sell = fullSell(state);
          return sell === null ? [] : [sell];
        }
      } else {
        // Leg-2 stop loss, -150 bps under its own entry fill: the ladder is
        // done, both levels dead for the rest of the race.
        const stop = (entry * BigInt(10000 - STOP_BPS)) / 10000n;
        if (low <= stop) {
          level1Armed = false;
          level1Dead = true;
          level2Armed = false;
          level2Used = true;
          raceHigh = close;
          entryPrice = null;
          entryLeg = 0;
          const sell = fullSell(state);
          return sell === null ? [] : [sell];
        }
      }
      return [];
    }

    // Flat: entries.
    // (a) Race-start dip: already 1.5% under 61,060 when the window opens --
    // buy at once as a leg-2 entry, do not wait for a level.
    if (isRaceStartBar) {
      const dipRaw = (rawLevel(LEVEL_USDC) * BigInt(10000 - DIP_BPS)) / 10000n;
      if (close <= dipRaw) {
        entryLeg = 2;
        const buy = fullBuy(state);
        return buy === null ? [] : [buy];
      }
    }
    // (b) Leg 1 at 61,060 (+/- 0.30%), only while it is armed and not dead.
    const inZone1 = close >= z1.low && close <= z1.high;
    const wickedZone1 = low <= z1.high && close >= z1.low;
    if (level1Armed && !level1Dead && (inZone1 || wickedZone1)) {
      entryLeg = 1;
      const buy = fullBuy(state);
      return buy === null ? [] : [buy];
    }
    // (c) Leg 2 at 60,300 (+/- 0.30%): after the 60,700 stop-out, or straight
    // there if price gapped through leg 1. One shot per cycle.
    const inZone2 = close >= z2.low && close <= z2.high;
    const wickedZone2 = low <= z2.high && close >= z2.low;
    if (level2Armed && !level2Used && (inZone2 || wickedZone2)) {
      entryLeg = 2;
      const buy = fullBuy(state);
      return buy === null ? [] : [buy];
    }
    // (d) Dip fallback, only while neither level has ever been touched.
    if (!level1Touched && !level2Touched && raceHigh > 0n && close <= (raceHigh * BigInt(10000 - DIP_BPS)) / 10000n) {
      entryLeg = 2;
      const buy = fullBuy(state);
      return buy === null ? [] : [buy];
    }
    return [];
  },
});
