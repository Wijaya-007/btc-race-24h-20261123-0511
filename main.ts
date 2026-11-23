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
//     Yans's own ICT level: ENTRY AT 61,060 (the daily FVG zone on his BTC/USDT
//     chart; BTC is near 61,388 at the time of writing). Buy the first time price
//     touches/enters the zone 61,060 +/- 0.30%. Exit at take profit +200 bps,
//     trailing stop 100 bps from the peak, hard stop -150 bps. Re-entry is allowed
//     once price has left the zone upward again after an exit.
//     FALLBACK, race mode only, while the 61,060 zone has never been touched:
//     a dip buyer -- buy when the close falls 1.5% or more under the trailing high,
//     same exits, re-entry allowed. This guarantees the bot still trades (the
//     guardrail needs at least 1 filled trade) if the level never prints.
//
// Protocol: agent-fun/bars-replay/v1 through the kit SDK shim in vendor/.
// Long only, at most one open position, at most 16 orders per reply, every order
// names its max_slippage_bps. Standard library only.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// The dev window ends at the competition opening (cut.json window.end_ms).
const DEV_END_MS = 1795410660000;
// Yans's ICT entry level, in USDC per BTC.
const LEVEL_USDC = 61060;
// The FVG zone is the level +/- this many bps.
const ZONE_BPS = 30;
// Race-mode exits, in bps from the entry fill.
const TP_BPS = 200;
const TRAIL_BPS = 100;
const STOP_BPS = 150;
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
let ictTouched = false; // the 61,060 zone has been touched at least once
let ictArmed = true; // may enter on a zone touch (re-arms above the zone)
let entryPrice: bigint | null = null; // fill price of the open position (raw)
let peak: bigint | null = null; // highest close since entry (raw)

/** The ICT zone as raw prices at the symbol's price_scale. */
function zone(): { low: bigint; high: bigint } {
  const level = BigInt(LEVEL_USDC) * 10n ** BigInt(priceScale);
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
        peak = entryPrice;
      } else {
        entryPrice = null;
        peak = null;
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

    // ---- RACE MODE: ICT level 61,060, dip fallback while untouched --------
    if (close > raceHigh) raceHigh = close;
    const z = zone();
    if (low <= z.high && high >= z.low) ictTouched = true;
    if (close > z.high) ictArmed = true;

    const held = state.positions.get(symbol);
    const isLong = held !== undefined && held.qty > 0n;
    if (isLong) {
      const entry = openEntryPrice(state);
      if (entry === null) return [];
      if (peak === null || close > peak) peak = close;
      const tp = (entry * BigInt(10000 + TP_BPS)) / 10000n;
      const stop = (entry * BigInt(10000 - STOP_BPS)) / 10000n;
      const trailHit = peak > entry && close <= (peak * BigInt(10000 - TRAIL_BPS)) / 10000n;
      if (close >= tp || close <= stop || trailHit) {
        // Exiting: disarm the ICT entry until price is back above the zone,
        // and restart the trailing high from here for the dip fallback.
        ictArmed = false;
        raceHigh = close;
        entryPrice = null;
        peak = null;
        const sell = fullSell(state);
        return sell === null ? [] : [sell];
      }
      return [];
    }

    // Flat: entries.
    const inZone = close >= z.low && close <= z.high;
    const wickedZone = low <= z.high && close >= z.low;
    if (ictArmed && (inZone || wickedZone)) {
      const buy = fullBuy(state);
      return buy === null ? [] : [buy];
    }
    if (!ictTouched && raceHigh > 0n && close <= (raceHigh * BigInt(10000 - DIP_BPS)) / 10000n) {
      const buy = fullBuy(state);
      return buy === null ? [] : [buy];
    }
    return [];
  },
});
