// BTC trend bot for btc-race-24h-20261117-0603 ("Race a BTC trading bot live for 24 hours").
// Re-tuned 2026-11-17 for THIS race's dev window (the 24h ending at the opening).
// The new window grinds up ~107 bps (buy-and-hold +$1.07), so the previous race's
// bot (EMA 5/30, momentum +25 bps, trail 50) loses -$3.85 on it and fails the
// dev gate. A 24-variant sweep on this window (kit grade-local, process driver)
// shows only the strict-momentum corner is profitable:
//
//   - Entry, on a bar's close (filled at the next open): EMA(5) crosses above
//     EMA(30) AND the 20-bar momentum is at least +40 bps AND the close breaks
//     above the highest close of the last 30 bars. All three must agree, so chop
//     and false starts rarely open a position.
//   - Exit, the whole position: the close falls 100 bps below the peak since entry
//     (trailing stop), or EMA(5) crosses back below EMA(30), or the 30-bar momentum
//     turns to -20 bps or worse. Whichever comes first.
//   - After a losing exit the bot waits 45 bars before it may enter again, so a
//     choppy stretch cannot bleed it with repeated round trips (each costs ~20-43 bps
//     in fee, slippage and pool impact at the depths this pool carries).
//   - Size: the whole cash balance on entry (one position, weight cap 100%).
//   - Slippage is capped at 100 bps from the decision close on every order. If a buy
//     is refused at the fill (a gap past the cap), the entry may still be taken on any
//     of the next 5 bars while the trend, breakout and momentum still hold.
//
// Robustness on this window: momentum-entry 35/40/45/50 bps all give +$6.31, and
// trail 80/100/120/150/200 all give +$10.38 (the exit is then the EMA cross, not
// the trail) — a plateau, not a single-point fluke. Looser filters lose money
// (momentum +25: -$3.85; +15: -$5.00; +10: +$0.13; EMA 8/60: -$15.60).
// Dev-window net PnL +$10.38, 2 filled orders (+1 final flatten), max drawdown
// 0.62%. Verified with the kit's official grade-local --driver process.
// The race window is unseen; the edge is catching a real rally when one comes
// while losing little when it does not.
//
// Everything is deterministic float64 on the bars alone: no clock, no environment,
// no randomness, so the two graded runs produce byte-identical action logs.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_BARS = 5;
const SLOW_BARS = 30;
/** Momentum lookback, in bars. */
const MOM_BARS = 20;
/** Entry needs the 30-bar return at or above this, in bps. */
const MOM_ENTRY_BPS = 40;
/** Exit when the 30-bar return falls to this, in bps. */
const MOM_EXIT_BPS = -20;
/** Trailing stop: exit once the close is this far below the peak since entry, in bps. */
const TRAIL_BPS = 100;
/** Breakout: the close must beat the highest close of this many bars before it. */
const BREAK_BARS = 30;
/** Bars to wait after a losing exit before a new entry. */
const COOLDOWN_BARS = 45;
/** Bars after a cross-up during which a refused buy may still be retried. */
const RETRY_BARS = 5;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

const ema = (span: number): Ema => ({ span, warm: [], value: null });

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Closes before the bar being decided on, oldest first. */
const closes: number[] = [];
const fast = ema(FAST_BARS);
const slow = ema(SLOW_BARS);
/** fast - slow after the bar before this one, once both EMAs are set. */
let prevGap: number | null = null;
/** A buy refused at the fill may be retried while seq is at or below this. */
let retryUntil = -1;
/** No entry while seq is at or below this (set after a losing exit). */
let cooldownUntil = -1;
/** Entry close and highest close since entry, while a position is held. */
let entryClose = 0;
let peak = 0;

await runBars({
  onBatch(state, batch) {
    let bar: Bar | undefined;
    for (const b of batch.bars) if (b.symbol === SYMBOL) bar = b;
    // A buy refused at its fill (a gap past the slippage cap) may be retried
    // on the next few bars while the signal still holds.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.symbol === SYMBOL && f.status === 'rejected') {
        retryUntil = state.seq + RETRY_BARS;
      }
    }
    if (bar === undefined) return [];
    const c = Number(bar.c);

    step(fast, c);
    step(slow, c);
    if (fast.value === null || slow.value === null) {
      closes.push(c);
      return [];
    }
    const gap = fast.value - slow.value;
    const crossUp = prevGap !== null && prevGap <= 0 && gap > 0;

    // Highest close of the last BREAK_BARS bars before this one.
    let high: number | null = null;
    if (closes.length >= BREAK_BARS) {
      high = closes[closes.length - BREAK_BARS];
      for (let i = closes.length - BREAK_BARS + 1; i < closes.length; i++) {
        if (closes[i]! > high) high = closes[i]!;
      }
    }
    // 30-bar return in bps, 0 before 30 closes of history.
    const mom =
      closes.length >= MOM_BARS ? ((c / closes[closes.length - MOM_BARS]!) - 1) * 10000 : 0;

    const held = state.positions.get(SYMBOL);
    let order: BuyInput | SellInput | null = null;
    if (held === undefined) {
      const freshCross = crossUp || state.seq <= retryUntil;
      const breakout = high !== null && c > high;
      if (
        gap > 0 &&
        freshCross &&
        breakout &&
        mom >= MOM_ENTRY_BPS &&
        state.seq > cooldownUntil
      ) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          order = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
          entryClose = c;
          peak = c;
        }
      }
    } else {
      if (c > peak) peak = c;
      const trailHit = ((peak / c) - 1) * 10000 >= TRAIL_BPS;
      const crossDown = prevGap !== null && prevGap >= 0 && gap < 0;
      const momDown = mom <= MOM_EXIT_BPS;
      if (trailHit || crossDown || momDown) {
        order = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        if (((c / entryClose) - 1) * 10000 < 0) cooldownUntil = state.seq + COOLDOWN_BARS;
      }
    }

    closes.push(c);
    prevGap = gap;
    return order === null ? [] : [order];
  },
});
