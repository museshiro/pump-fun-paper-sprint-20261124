# Second Buyer — Pump.fun Paper Sprint Bot

[![Pump.fun Paper Sprint](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/museshiro/pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/museshiro/pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot on the `agent-fun/replay/v2` harness. Built by [museshiro](https://make.fun/r/xrr5vp10).

## Strategy: be the second buyer

Most pump.fun coins die within seconds of launch. The winners share one shape at
birth: a single real buyer steps in first, the curve already holds a few SOL, and the
price has started moving but not run away. This bot buys exactly there — in a coin's
first five slots, when exactly one non-creator wallet has bought it, real SOL is
2.25–5, the price is up 0–50% from creation, at least 0.05 SOL has been bought, and
net flow over the last 10 slots is non-negative. One 0.04 SOL buy (clipped to the 1%
of-reserve cap), with 1000 bps buy slippage so an adverse fill in the 2-slot latency
is rejected for free instead of bought at the top.

Exits do the work: sell half at +12%, then ride the rest on a 10% trailing stop
armed from entry, so the rare coin that runs +100–500% pays for the many that do
not. Hard stop −12%, max hold 600 slots, instant exit if the creator sells while
we hold. At most 3 snipe positions open at once.

Guardrail probes keep the run honest: the entry must clear 20 distinct coins with
0.01 SOL round trips, so when the snipe lags a pace of 22 coins / 44 fills over the
6h window, the bot takes a 0.015 SOL round trip on a new coin it passed on and sells
exactly those tokens as soon as the buy lands.

## What did not make it (and why)

- **Dip-buying** — tested first, it is a falling-knife catcher on this data.
- **Mature-curve momentum** — the kit's momentum pilot loses 9.4 SOL on dev; a
  smaller, faster version still lost money.
- **Completion riding** — by the time a coin shows 60+ SOL real, the 2-slot latency
  means the buy is rejected as `token_complete`; the only coins that do fill are the
  ones that stall and dump. (Coins that reach 80 SOL real complete 93% of the time —
  but the entry is untradeable.)

## Backtest (kit's frozen 24h dev dataset, pilot offline simulator)

| | net PnL |
|---|---|
| hold-cash | 0.000 SOL |
| equal-weight | −0.017 SOL |
| sniper pilot | −0.138 SOL |
| reversion pilot | −1.779 SOL |
| momentum pilot | −9.384 SOL |
| **this bot, dev part 0 (11.1h)** | **+0.028 SOL** |
| **this bot, full 24h dev** | **−0.006 SOL** |
| **this bot, true 6h slices** | **+0.009 / +0.003 / −0.038 SOL** |

Guardrails on every true 6h slice: 24–28 distinct coins, 24–28 round trips ≥0.01 SOL,
max drawdown 0.002–0.004 (limit 0.50). Two consecutive local runs produce
byte-identical action logs.

The honest read: this market is close to efficient at these timescales and the edge
is thin — the bot is roughly breakeven on dev with a real chance of a positive 6h
window (2 of 3 dev slices), and it beats every pilot by a wide margin. It never
bets the house: max 3 positions, 0.04 SOL stakes, −12% stops.

## Files

- `main.ts` — entrypoint: hands the strategy to the vendored shim.
- `strategy.ts` — the strategy (all logic, written fresh for this entry).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte for byte (excluded from
  authorship counts, as the kit instructs).

## License

MIT — see [LICENSE](LICENSE).
