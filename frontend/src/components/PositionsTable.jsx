import { useCurrency } from '../context/CurrencyContext'

export default function PositionsTable({ positions, loading }) {
  const { formatMoney } = useCurrency()
  if (loading) return <div className="table-loading">Loading positions...</div>
  if (!positions.length) return <div className="empty-state">No open positions</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Pair</th>
          {positions[0]?.exchange && <th>Exchange</th>}
          <th>Direction</th>
          <th>Size</th>
          <th>Entry Price</th>
          <th>Current Price</th>
          <th>P&L $</th>
          <th>P&L %</th>
          <th>Liq. Price</th>
          <th>Leverage</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p, i) => (
          <tr key={i}>
            <td><span className="asset-badge" style={{ color: '#6366f1', background: '#6366f122' }}>{p.symbol}</span></td>
            {p.exchange && <td style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>{p.exchange}</td>}
            <td style={{ color: p.side === 'Buy' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {p.side === 'Buy' ? '▲ Long' : '▼ Short'}
            </td>
            <td>{p.size}</td>
            <td>{formatMoney(p.entryPrice ?? 0, 4)}</td>
            <td>{formatMoney(p.markPrice ?? 0, 4)}</td>
            <td style={{ color: (p.pnl ?? 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {(p.pnl ?? 0) >= 0 ? '+' : ''}{formatMoney(p.pnl ?? 0)}
            </td>
            <td style={{ color: (p.pnlPct ?? 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {(p.pnlPct ?? 0) >= 0 ? '+' : ''}{(p.pnlPct ?? 0).toFixed(2)}%
            </td>
            <td style={{ color: '#ef4444' }}>{p.liquidationPrice > 0 ? formatMoney(p.liquidationPrice) : '—'}</td>
            <td><span className="leverage-badge">{p.leverage}x</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
