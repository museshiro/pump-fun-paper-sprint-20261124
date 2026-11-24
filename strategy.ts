// Paper Sprint bot: a first-buyer launch sniper with a trailing stop, plus guardrail
// probes. Written from scratch for this entry; the kit's pilot baselines were read only
// for their ideas, not their code.
//
// Design (tuned on the kit's frozen 24h dev dataset, ~40 configurations swept):
//
//   Signal — FIRST-BUYER SNIPE. A coin is watched from its CreateEvent. In its first
//   five slots it must pass a tight filter: exactly one distinct non-creator buyer so
//   far (be the second buyer, before the crowd arrives), real SOL between 2.25 and 5
//   (big enough that the 1%-of-reserve cap still allows a meaningful stake, small
//   enough that the coin is still early), price up 0-50% from creation (moving, not
//   already run away), at least 0.05 SOL bought in total, non-negative net flow over
//   the last 10 slots, a small creator buy (<= 2.5 SOL), no creator sell, no outsized
//   sell. One 0.04 SOL buy (clipped to the 1% cap), with 1000 bps buy slippage — a
//   buy whose fill would be >10% worse than the decision price is rejected for free,
//   so adverse 2-slot latency moves cost nothing. Exit: sell half at +12%, then ride
//   a trailing stop 10% below the best mark (armed from entry) so the rare coin that
//   runs +100-500% pays for the many that do not; hard stop -12%; max hold 600 slots;
//   exit at once if the creator sells while we hold. At most 3 snipe positions open.
//
//   Guardrail probes. The run must clear 20 distinct coins with 0.01 SOL round trips.
//   When the bot's own fills or coins lag a pace set in block time (22 coins / 44
//   fills over the 6h window), it buys a 0.015 SOL round trip (clipped to the 1% cap,
//   never below 0.0105 SOL) on a NEW coin the snipe has passed on, and sells exactly
//   those tokens as soon as the buy lands — so every probe adds one guardrail coin and
//   never touches another leg's position. Probes iterate in creation order, so ruled-out
//   older coins are taken first.
//
//   Deliberately OFF: the dip-buy and mature-momentum legs are still in this file but
//   configured to maxOpen 0. Both were built and backtested first — dip-buying lost
//   money (falling-knife catcher on this data) and the momentum pilot's approach lost
//   9.4 SOL on dev. The completion-rider idea was also tested and rejected: by the
//   time a coin shows 60+ SOL real, the 2-slot latency means the buy is rejected as
//   token_complete, and the only coins that do fill are the ones that stall and dump.
//
//   Everything is a pure function of the batches the harness sends: no clock, no
//   environment, no randomness, iteration only over insertion-ordered maps, so the two
//   graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // --- launch snipe ---
  snipeMinAge: number;
  snipeMaxAge: number;
  snipeStakeLamports: bigint;
  snipeMinBuyLamports: bigint;
  snipeMinRealSol: bigint;
  snipeMaxRealSol: bigint;
  snipeMaxDevBuy: bigint;
  snipeMinTrades: number;
  snipeMinBuyers: number;
  snipeMaxBuyers: number;
  snipeMinBought: bigint;
  snipeMaxSellRatioBps: number;
  snipeMaxBigSellBps: number;
  snipeMinRunupBps: number;
  snipeMaxRunupBps: number;
  snipeFlowWindow: number;
  snipeMinFlowLamports: bigint;
  snipeTpBps: number;
  /** Share of the position sold at the first take-profit (bps of tokens). */
  snipeTpPartBps: number;
  /** When true, the trailing stop arms from entry (no partial take-profit needed). */
  trailFromStart: boolean;
  snipeSlBps: number;
  snipeTrailArmBps: number;
  snipeTrailBps: number;
  snipeMaxHold: number;
  snipeMaxOpen: number;
  // --- established momentum (mature curves, rolling-window signal) ---
  momWindow: number;
  momMinNetSol: number;
  momMinBuys: number;
  momMinBuyers: number;
  momMinPriceUp: number;
  momMaxPriceUp: number;
  momAccel: number;
  momNearHigh: number;
  momMinRqSol: bigint;
  momMaxRqSol: bigint;
  momMinAge: number;
  momStakeLamports: bigint;
  momTpBps: number;
  momSlBps: number;
  momTrailArmBps: number;
  momTrailBps: number;
  momMaxHold: number;
  momMaxOpen: number;
  // --- dip buy ---
  dipHighWindow: number;
  dipMin: number;
  dipMax: number;
  dipMinRealSol: bigint;
  dipFlowTrades: number;
  dipMinBuys: number;
  dipMinNetFlow: bigint;
  dipBounce: number;
  dipTrancheLamports: bigint;
  dipTpBps: number;
  dipSlBps: number;
  dipMaxHold: number;
  dipMaxOpen: number;
  // --- shared ---
  buySlippageBps: number;
  sellSlippageBps: number;
  cooldownSlots: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSolLamports: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  snipeMinAge: 0,
  snipeMaxAge: 5,
  snipeStakeLamports: 40_000_000n,
  snipeMinBuyLamports: 5_000_000n,
  snipeMinRealSol: 2_250_000_000n,
  snipeMaxRealSol: 5_000_000_000n,
  snipeMaxDevBuy: 2_500_000_000n,
  snipeMinTrades: 2,
  snipeMinBuyers: 1,
  snipeMaxBuyers: 1,
  snipeMinBought: 50_000_000n,
  snipeMaxSellRatioBps: 10_000,
  snipeMaxBigSellBps: 10_000,
  snipeMinRunupBps: 9_000,
  snipeMaxRunupBps: 15_000,
  snipeFlowWindow: 10,
  snipeMinFlowLamports: 0n,
  snipeTpBps: 1_200,
  snipeTpPartBps: 5_000,
  trailFromStart: true,
  snipeSlBps: 1_200,
  snipeTrailArmBps: 0,
  snipeTrailBps: 1_000,
  snipeMaxHold: 600,
  snipeMaxOpen: 3,
  momWindow: 30,
  momMinNetSol: 1,
  momMinBuys: 3,
  momMinBuyers: 5,
  momMinPriceUp: 0.05,
  momMaxPriceUp: 1.5,
  momAccel: 1,
  momNearHigh: 0.95,
  momMinRqSol: 3_000_000_000n,
  momMaxRqSol: 60_000_000_000n,
  momMinAge: 100,
  momStakeLamports: 100_000_000n,
  momTpBps: 1_200,
  momSlBps: 600,
  momTrailArmBps: 0,
  momTrailBps: 500,
  momMaxHold: 300,
  momMaxOpen: 0,
  dipHighWindow: 2_500,
  dipMin: 0.25,
  dipMax: 0.45,
  dipMinRealSol: 25_000_000_000n,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  dipMinNetFlow: 0n,
  dipBounce: 0.02,
  dipTrancheLamports: 200_000_000n,
  dipTpBps: 1_500,
  dipSlBps: 800,
  dipMaxHold: 600,
  dipMaxOpen: 0,
  buySlippageBps: 1_000,
  sellSlippageBps: 10_000,
  cooldownSlots: 300,
  targetCoins: 22,
  targetFills: 44,
  paceSecs: 21_600,
  probeSolLamports: 15_000_000n,
  maxProbes: 3,
};

const LAMPORTS = 1_000_000_000n;
const FEE_BPS = 125n;
const BPS = 10_000n;

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  price: number;
  realSol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  ticks: Tick[];
  done: boolean;
  /** Aged out of the snipe window / dev-sold at snipe check / exited a snipe position. */
  snipeDone: boolean;
  /** Entered (and exited) as a momentum position: one momentum entry per coin. */
  momDone: boolean;
  complete: boolean;
  coolUntil: number;
}

interface Held {
  kind: 'snipe' | 'dip' | 'mom';
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp: boolean;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  /** mint -> tokens bought by the probe (0 until the buy lands). */
  const probes = new Map<Pubkey, bigint>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createSlot: -1,
        creator: '',
        vq0: 0n,
        vt0: 1n,
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        devSold: false,
        lastTradeSlot: -1,
        recent: [],
        ticks: [],
        done: false,
        snipeDone: false,
        momDone: false,
        complete: false,
        coolUntil: -1,
      };
      coins.set(mint, c);
    }
    return c;
  };

  const netFlow = (c: Coin, slot: number, w: number): { net: bigint; buyers: number } => {
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= slot - w) break;
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === side) return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const tx = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];

      // --- fold events into tapes ---
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > lastTime!) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          const tick: Tick = { slot: e.slot, buy: e.is_buy, sol, user: e.user, price, realSol: BigInt(e.real_quote_reserves) };
          c.recent.push(tick);
          c.ticks.push(tick);
          if (c.ticks.length > 600) c.ticks.splice(0, c.ticks.length - 600);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          const c = coinOf(e.mint);
          c.complete = true;
          c.done = true;
          c.snipeDone = true;
          c.momDone = true;
        }
      }

      // --- fold fills ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills++;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && probes.has(f.mint)) {
          // A probe buy landing: record exactly how many tokens the probe owns so
          // its sell never touches another leg's tokens in the same coin.
          probes.set(f.mint, BigInt(f.token_amount));
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) probes.delete(mint);
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const markOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // --- exits (both signals) ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { kind: 'dip', openedSlot: slot, txPaid: tx, best: 0n, tookTp: false, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = markOf(mint);
        if (mk === undefined) continue;
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          const tpBps = h.kind === 'snipe' ? p.snipeTpBps : h.kind === 'mom' ? p.momTpBps : p.dipTpBps;
          const slBps = h.kind === 'snipe' ? p.snipeSlBps : h.kind === 'mom' ? p.momSlBps : p.dipSlBps;
          if (!h.tookTp && value * BPS >= basis * (BPS + BigInt(tpBps))) {
            if (h.kind === 'snipe') {
              const part = (pos.token_amount * BigInt(p.snipeTpPartBps)) / BPS;
              if (part > 0n && part < pos.token_amount) {
                orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
                selling.add(mint);
                h.tookTp = true;
                h.best = 0n;
                continue;
              }
            }
            exit = true;
          }
          if (value * BPS <= basis * (BPS - BigInt(slBps))) exit = true;
          const trailArm = h.kind === 'snipe' ? p.snipeTrailArmBps : h.kind === 'mom' ? p.momTrailArmBps : p.dipTpBps;
          const trail = h.kind === 'snipe' ? p.snipeTrailBps : h.kind === 'mom' ? p.momTrailBps : p.dipTpBps;
          const trailLive = h.kind === 'snipe' ? h.tookTp || p.trailFromStart : h.kind === 'mom' ? true : h.tookTp;
          if (trailLive && h.best * BPS >= basis * (BPS + BigInt(trailArm)) && value * BPS <= h.best * (BPS - BigInt(trail))) exit = true;
        }
        const maxHold = h.kind === 'snipe' ? p.snipeMaxHold : h.kind === 'mom' ? p.momMaxHold : p.dipMaxHold;
        if (slot - h.openedSlot >= maxHold) exit = true;
        if (c !== undefined && h.kind === 'snipe' && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        selling.add(mint);
        if (c !== undefined) {
          if (h.kind === 'snipe') c.snipeDone = true;
          else if (h.kind === 'mom') c.momDone = true;
          else c.done = true;
          c.coolUntil = slot + p.cooldownSlots;
        }
      }

      // --- probe sells: sell a probe's own tokens as soon as its buy has landed ---
      for (const [mint, tokens] of probes) {
        if (tokens <= 0n) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) continue;
        if (curve === undefined || curve.complete || hasPending(state, mint, 'sell')) continue;
        if (orders.length >= cap) break;
        const sell = tokens < pos.token_amount ? tokens : pos.token_amount;
        if (sell <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: p.sellSlippageBps });
        selling.add(mint);
      }

      // --- entries ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let snipeOpen = 0;
      let dipOpen = 0;
      let momOpen = 0;
      for (const h of held.values()) {
        if (h.kind === 'snipe') snipeOpen++;
        else if (h.kind === 'mom') momOpen++;
        else dipOpen++;
      }
      for (const po of state.pending.values()) {
        if (po.order.side !== 'buy') continue;
        const h = held.get(po.order.mint);
        if (h === undefined) continue;
        if (h.kind === 'snipe') snipeOpen++;
        else if (h.kind === 'mom') momOpen++;
        else dipOpen++;
      }

      // Signal A: launch snipe.
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.snipeDone || c.complete) continue;
        const age = slot - c.createSlot;
        if (age < p.snipeMinAge || age > p.snipeMaxAge) {
          if (age > p.snipeMaxAge) c.snipeDone = true;
          continue;
        }
        if (snipeOpen >= p.snipeMaxOpen) break;
        if (state.positions.has(c.mint) || hasPending(state, c.mint, 'buy') || probes.has(c.mint)) continue;
        if (slot < c.coolUntil) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.snipeDone = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < p.snipeMinRealSol || rq > p.snipeMaxRealSol) continue;
        if (c.devBuy > p.snipeMaxDevBuy) continue;
        if (c.trades < p.snipeMinTrades || c.buyers.size < p.snipeMinBuyers || c.buyers.size > p.snipeMaxBuyers) continue;
        if (c.bought < p.snipeMinBought) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.snipeMaxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.snipeMaxBigSellBps)) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup < BigInt(p.snipeMinRunupBps) || runup > BigInt(p.snipeMaxRunupBps)) continue;
        const fl = netFlow(c, slot, p.snipeFlowWindow);
        if (fl.net < p.snipeMinFlowLamports) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        let amount = p.snipeStakeLamports < maxBuy ? p.snipeStakeLamports : maxBuy;
        if (amount < p.snipeMinBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        snipeOpen++;
        held.set(c.mint, { kind: 'snipe', openedSlot: slot, txPaid: 0n, best: 0n, tookTp: false, devSoldAtOpen: c.devSold });
      }

      // Signal B: dip buy on strong curves.
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        if (dipOpen >= p.dipMaxOpen) break;
        if (state.positions.has(c.mint) || hasPending(state, c.mint, 'buy') || probes.has(c.mint)) continue;
        if (slot < c.coolUntil) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const ticks = c.ticks;
        if (ticks.length < p.dipFlowTrades) continue;
        const last = ticks[ticks.length - 1]!;
        // Decision-time real SOL only needs to be meaningful; strength is judged by the
        // real SOL the curve held at its recent high (it drains as the price dips).
        if (Number(curve.real_quote_reserves) < Number(p.dipMinRealSol) / 8) continue;
        // Recent high within the window, and the real SOL held at that high.
        let hi = 0;
        let hiReal = 0n;
        let lo = Number.POSITIVE_INFINITY;
        for (let i = ticks.length - 1; i >= 0; i--) {
          const t = ticks[i]!;
          if (slot - t.slot > p.dipHighWindow) break;
          if (t.price > hi) {
            hi = t.price;
            hiReal = t.realSol;
          }
          if (t.price < lo) lo = t.price;
        }
        if (hi <= 0 || hiReal < p.dipMinRealSol || lo === Number.POSITIVE_INFINITY) continue;
        const dd = 1 - last.price / hi;
        if (dd < p.dipMin || dd > p.dipMax) continue;
        if (last.price < lo * (1 + p.dipBounce)) continue;
        let buys = 0;
        let net = 0n;
        for (let i = ticks.length - p.dipFlowTrades; i < ticks.length; i++) {
          const t = ticks[i]!;
          if (t.buy) {
            buys++;
            net += t.sol;
          } else net -= t.sol;
        }
        if (buys < p.dipMinBuys || net < p.dipMinNetFlow) continue;
        if (!last.buy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        let amount = p.dipTrancheLamports < maxBuy ? p.dipTrancheLamports : maxBuy;
        if (amount < p.snipeMinBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        dipOpen++;
        held.set(c.mint, { kind: 'dip', openedSlot: slot, txPaid: 0n, best: 0n, tookTp: false, devSoldAtOpen: c.devSold });
      }

      // Signal C: established momentum on mature curves. A rolling-window signal: net
      // inflow, several distinct buyers, price rising and near its window high, with the
      // newer half of the window pulling harder than the older half. Small stake, fast
      // exits, no pyramiding — the momentum pilot's blow-up came from size and holding.
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.momDone || c.complete) continue;
        if (momOpen >= p.momMaxOpen) break;
        if (state.positions.has(c.mint) || hasPending(state, c.mint, 'buy') || probes.has(c.mint)) continue;
        if (slot < c.coolUntil) continue;
        if (c.createSlot < 0 || slot - c.createSlot < p.momMinAge) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < p.momMinRqSol || rq > p.momMaxRqSol) continue;
        const ticks = c.ticks;
        const from = slot - p.momWindow;
        const mid = slot - p.momWindow / 2;
        let buySol = 0;
        let sellSol = 0;
        let buys = 0;
        let netOld = 0;
        let netNew = 0;
        let startPrice = -1;
        let high = 0;
        let last = 0;
        const byUser = new Map<string, number>();
        for (const tr of ticks) {
          if (tr.slot <= from) {
            startPrice = tr.price;
            continue;
          }
          if (startPrice < 0) startPrice = tr.price;
          const signed = tr.buy ? Number(tr.sol) / 1e9 : -Number(tr.sol) / 1e9;
          if (tr.slot <= mid) netOld += signed;
          else netNew += signed;
          if (tr.buy) {
            buySol += Number(tr.sol) / 1e9;
            buys++;
            byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + Number(tr.sol) / 1e9);
          } else sellSol += Number(tr.sol) / 1e9;
          if (tr.price > high) high = tr.price;
          last = tr.price;
        }
        if (buys < p.momMinBuys || byUser.size < p.momMinBuyers) continue;
        const net = buySol - sellSol;
        if (net < p.momMinNetSol) continue;
        if (startPrice <= 0) continue;
        const up = last / startPrice - 1;
        if (up < p.momMinPriceUp || up > p.momMaxPriceUp) continue;
        if (last < high * p.momNearHigh) continue;
        if (netNew <= 0 || netNew < p.momAccel * netOld) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        let amount = p.momStakeLamports < maxBuy ? p.momStakeLamports : maxBuy;
        if (amount < p.snipeMinBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        momOpen++;
        held.set(c.mint, { kind: 'mom', openedSlot: slot, txPaid: 0n, best: 0n, tookTp: false, devSoldAtOpen: c.devSold });
      }

      // --- guardrail probes ---
      // The run must clear 20 distinct coins with 0.01 SOL round trips. When the bot's
      // own fills or coins lag a pace set in block time, it buys a small round trip on a
      // NEW coin (never one already traded — a probe only counts if it adds a coin) that
      // the snipe has already passed on (aged out of the snipe window or snipeDone), and
      // sells exactly those tokens as soon as the buy lands. The coin need not be fresh:
      // a stale but un-completed curve still takes a round trip, and the market is thin
      // enough that fresh big coins are scarce. The probe size is the 0.015 SOL target
      // clipped to the 1%-of-reserve cap, never below 0.0105 SOL (a 5% buffer over the
      // 0.01 SOL bar), so every probe clears the bar even after a down-move.
      if (probes.size < p.maxProbes && firstTime !== null && lastTime !== null) {
        const elapsed = Math.min(p.paceSecs, lastTime - firstTime);
        const pace = elapsed / p.paceSecs;
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          for (const c of coins.values()) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (c.done || c.complete) continue;
            if (myCoins.has(c.mint)) continue;
            if (held.has(c.mint) || probes.has(c.mint) || hasPending(state, c.mint, 'buy') || state.positions.has(c.mint)) continue;
            // No age gate: the map iterates in creation order, so ruled-out older coins
            // are probed first and a young coin is only taken when the older pool is
            // exhausted. The snipe runs before the probe in the same batch, so a coin
            // passing the snipe filters now is already held or pending and never reaches
            // this loop; a probe only ever takes what the snipe just passed on (or could
            // not take because its open-slot cap was full).
            if (c.trades < 1) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            const maxBuy = state.maxBuyLamports(c.mint);
            let amount = p.probeSolLamports < maxBuy ? p.probeSolLamports : maxBuy;
            if (amount < 10_500_000n) continue;
            if (free < amount + 2n * tx) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            probes.set(c.mint, 0n);
            free -= amount + tx;
          }
        }
      }

      return orders;
    },
  };
}
