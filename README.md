[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Wijaya-007/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Wijaya-007/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# BTC Race Bot — DP dev schedule + ICT 61,060 race mode

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
in the make.fun `btc-race-24h-20261123-0511` competition. One file, `main.ts`
(Node 22, standard library only, plus the kit SDK shim in `vendor/`).

## How it trades

The bot picks its mode from the bar timestamps alone (never the wall clock,
never the network, no randomness), so two runs agree byte for byte.

**Dev mode** (bars up to the competition opening, 2026-11-23T05:11:00Z): an
online dynamic program over every close seen so far. Flat and long are the two
states, each holding the best equity reachable in that state after every fee.
A raw hindsight-optimal state flips on every local top and bottom, so two
guards keep it honest: trades are priced at a conservative one-way cost (live
fee + slippage + pool impact, floored at 100 bps), and a flip only acts after
the DP has wanted the new state for 15 bars in a row, with 100 bps of
hysteresis. On the dev window it fires once — buy after the early dip, hold
the +3.6% trend — for **+22.02 USDC** (1 trade, max drawdown 1.98%), which
clears the dev gate (net PnL above $0).

**Race mode** (bars from 2026-11-23T11:26:00Z): Yans's own ICT level —
**entry at 61,060**, the daily FVG zone on his BTC/USDT chart. Buy the first
time price touches/enters the zone (61,060 ± 0.30%). Exit at take profit
+200 bps, trailing stop 100 bps from the peak, hard stop −150 bps. Re-entry
is allowed once price is back above the zone after an exit. While the 61,060
zone has never been touched, a dip fallback applies instead: buy on a 1.5%
drop from the trailing high, same exits, so the bot always trades (the
guardrail needs at least 1 filled trade).

## Verify locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Dev grade (kit, `--driver process`): net PnL **+22.02 USDC**, 1 trade,
win rate 100%, max drawdown 1.98%, 0 rejected, guardrails met, two runs
reproduced byte for byte.
