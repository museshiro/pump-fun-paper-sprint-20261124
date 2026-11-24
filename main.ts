// First-buyer launch sniper for the Pump.fun Paper Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Strategy in one line: buy a coin in its first five slots when exactly one other
// wallet has bought it and 2.25-5 SOL sits in the curve, stake 0.04 SOL, sell half at
// +12%, ride the rest on a 10% trailing stop, cut at -12%. Guardrail probes top the
// coin count up to 22 over the 6h window. See strategy.ts for the full design note
// and the backtest numbers behind every parameter.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
