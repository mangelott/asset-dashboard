// Weighted-average-cost realized P&L, consistent with the avgEntryPrice
// calculation already used elsewhere in the adapters for open positions.
//
// `trades` must be sorted chronologically (oldest first), each item:
//   { side: 'buy'|'sell', qty: number, price: number, date, asset, ... }
//
// Returns the same trades annotated with `pnl`/`pnlPct` (null for buys —
// realized P&L only applies to sells).
function computeRealizedPnl(trades) {
  let qty = 0;
  let cost = 0;

  return trades.map(t => {
    if (t.side === 'buy') {
      qty += t.qty;
      cost += t.qty * t.price;
      return { ...t, pnl: null, pnlPct: null };
    }

    const avgCost = qty > 0 ? cost / qty : 0;
    const pnl = (t.price - avgCost) * t.qty;
    const pnlPct = avgCost > 0 ? ((t.price - avgCost) / avgCost) * 100 : 0;

    cost -= avgCost * t.qty;
    qty -= t.qty;
    if (qty < 0) qty = 0;
    if (cost < 0) cost = 0;

    return { ...t, pnl, pnlPct };
  });
}

module.exports = { computeRealizedPnl };
