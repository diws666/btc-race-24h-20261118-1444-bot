// Deep Dip 60: a dip-buying mean-reversion bot for cbBTC (CBBTC/USDC).
//
// Rules, all in integer arithmetic (bigint, no floats, no randomness):
//   - Track every batch's bar close. Once more than HORIZON closes are seen,
//     compare the close HORIZON bars ago with the latest close.
//   - FLAT: if the close fell at least DIP_BPS over the last HORIZON bars,
//     buy with all available cash.
//   - HOLDING: track the best (highest) close since entry. Sell everything
//     if the position is worth TP_BPS over its cost, or it has trailed
//     TRAIL_BPS off its best close, or it is worth SL_BPS under its cost.
//   - A full-size round trip pays ~26 bps in fees, slippage and impact, so
//     a trade only fires on a move comfortably larger than that.
//
// Position value mirrors the replay's accounting: qty * close / 10^7,
// in micro-USDC (quote units).

import { runBars, type Bar, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const HORIZON = 60;
const DIP_BPS = 110;
const TRAIL_BPS = 80;
const TP_BPS = 200;
const SL_BPS = 80;
const MAX_SLIPPAGE_BPS = 100;

const closes: bigint[] = [];
let best: bigint | null = null;

/** This batch's bar close: the first bar carrying `c`, else the first bar's `c`. */
function batchClose(bars: Bar[]): bigint {
  let barC = 0n;
  for (const b of bars) {
    if (b.c !== undefined) {
      barC = BigInt(b.c);
      break;
    }
  }
  if (barC === 0n && bars.length > 0) barC = BigInt(bars[0]!.c ?? '0');
  return barC;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const barC = batchClose(batch.bars);
    if (barC > 0n) closes.push(barC);

    if (state.warmingUp) return [];

    const held = state.positions.get('CBBTC');
    const qty = held?.qty ?? 0n;
    const cost = held?.cost ?? 0n;
    const cash = state.cash;

    const orders: (BuyInput | SellInput)[] = [];

    if (qty === 0n) {
      if (closes.length > HORIZON) {
        const past = closes[closes.length - (HORIZON + 1)]!;
        const curr = closes[closes.length - 1]!;
        const dropBps = ((past - curr) * 10000n) / past;
        if (dropBps >= BigInt(DIP_BPS) && cash > 1000000n) {
          orders.push({
            side: 'buy',
            client_id: `buy-${batch.seq}`,
            symbol: 'CBBTC',
            notional_quote_units: cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          best = curr;
        }
      }
    } else {
      if (best === null || barC > best) best = barC;
      const positionValue = (qty * barC) / 10n ** 7n;
      const takeProfit = positionValue >= (cost * BigInt(10000 + TP_BPS)) / 10000n;
      const trailing = best > 0n && ((best - barC) * 10000n) / best >= BigInt(TRAIL_BPS);
      const stopLoss = positionValue <= (cost * BigInt(10000 - SL_BPS)) / 10000n;
      if (takeProfit || trailing || stopLoss) {
        orders.push({
          side: 'sell',
          client_id: `sell-${batch.seq}`,
          symbol: 'CBBTC',
          qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        best = null;
      }
    }

    return orders;
  },
});
