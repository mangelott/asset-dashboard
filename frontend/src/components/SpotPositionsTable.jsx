import dayjs from 'dayjs'
import { useCurrency } from '../context/CurrencyContext'

export default function SpotPositionsTable({ positions, loading, isGlobal }) {
  const { formatMoney } = useCurrency()
  if (loading) return <div className="table-loading">Loading spot positions...</div>
  if (!positions.length) return <div className="empty-state">No spot holdings</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Asset</th>
          {isGlobal && <th>Exchange</th>}
          <th>Qty</th>
          <th>Avg Entry</th>
          <th>Current Price</th>
          <th>Open Value</th>
          <th>Current Value</th>
          <th>P&L $</th>
          <th>P&L %</th>
          <th>Since</th>
        </tr>
      </thead>
      <tbody>
        {positions.sort((a, b) => b.valueUsdt - a.valueUsdt).map((p, i) => (
          <tr key={i}>
            <td><span className="asset-badge" style={{ color: '#6366f1', background: '#6366f122' }}>{p.asset}</span></td>
            {isGlobal && <td style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>{p.exchange}</td>}
            <td>{p.quantity.toFixed(6)}</td>
            <td>{p.avgEntryPrice > 0 ? formatMoney(p.avgEntryPrice, 4) : '—'}</td>
            <td>{p.currentPrice > 0 ? formatMoney(p.currentPrice, 4) : '—'}</td>
            <td>{p.openValue > 0 ? formatMoney(p.openValue) : '—'}</td>
            <td><strong>{formatMoney(p.valueUsdt)}</strong></td>
            <td style={{ color: (p.pnl ?? 0) > 0 ? '#22c55e' : (p.pnl ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: (p.pnl ?? 0) !== 0 ? 700 : 400 }}>
              {(p.pnl ?? 0) !== 0 ? `${(p.pnl ?? 0) >= 0 ? '+' : ''}${formatMoney(p.pnl ?? 0)}` : '—'}
            </td>
            <td style={{ color: (p.pnlPct ?? 0) > 0 ? '#22c55e' : (p.pnlPct ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: (p.pnlPct ?? 0) !== 0 ? 700 : 400 }}>
              {(p.pnlPct ?? 0) !== 0 ? `${(p.pnlPct ?? 0) >= 0 ? '+' : ''}${(p.pnlPct ?? 0).toFixed(2)}%` : '—'}
            </td>
            <td style={{ fontSize: '12px', color: '#94a3b8' }}>
              {p.openDate ? dayjs(p.openDate).format('DD MMM YYYY') : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
