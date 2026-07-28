import { useState } from 'react'
import { useCurrency } from '../context/CurrencyContext'

export default function BalancesTable({ balances, totalUsdt, isGlobal, loading }) {
  const { formatMoney } = useCurrency()
  const [hideDust, setHideDust] = useState(false)
  if (loading) return <div className="table-loading">Loading balances...</div>
  if (!balances.length) return <div className="empty-state">No balances available</div>

  const visibleBalances = hideDust ? balances.filter(b => b.valueUsdt >= 1) : balances
  const spotBalances = visibleBalances.filter(b => b.type === 'Spot' || !b.type)
  const futuresBalances = visibleBalances.filter(b => b.type === 'Futures')

  const renderTable = (items, isFutures) => (
    <table>
      <thead>
        <tr>
          <th>Currency</th>
          {isGlobal && <th>Exchange</th>}
          <th>Amount</th>
          {!isFutures && <th>Avg Price</th>}
          {!isFutures && <th>Current Price</th>}
          <th>Value</th>
          {!isFutures && <th>P&L $</th>}
          {!isFutures && <th>P&L %</th>}
          <th>% Portfolio</th>
        </tr>
      </thead>
      <tbody>
        {items.sort((a, b) => b.valueUsdt - a.valueUsdt).map((b, i) => {
          const pct = totalUsdt > 0 ? ((b.valueUsdt / totalUsdt) * 100).toFixed(1) : 0
          const color = '#6366f1'
          return (
            <tr key={i}>
              <td><span className="asset-badge" style={{ color, background: `${color}22` }}>{b.asset}</span></td>
              {isGlobal && <td style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>{b.exchange}</td>}
              <td>{(parseFloat(b.free) + parseFloat(b.locked)).toFixed(6)}</td>
              {!isFutures && <td>{b.avgEntryPrice > 0 ? formatMoney(b.avgEntryPrice, 4) : '—'}</td>}
              {!isFutures && <td>{b.currentPrice > 0 ? formatMoney(b.currentPrice, 4) : '—'}</td>}
              <td><strong>{formatMoney(b.valueUsdt)}</strong></td>
              {!isFutures && (
                <td style={{ color: (b.pnl ?? 0) > 0 ? '#22c55e' : (b.pnl ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: (b.pnl ?? 0) !== 0 ? 700 : 400 }}>
                  {(b.pnl ?? 0) !== 0 ? `${(b.pnl ?? 0) >= 0 ? '+' : ''}${formatMoney(b.pnl ?? 0)}` : '—'}
                </td>
              )}
              {!isFutures && (
                <td style={{ color: (b.pnlPct ?? 0) > 0 ? '#22c55e' : (b.pnlPct ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: (b.pnlPct ?? 0) !== 0 ? 700 : 400 }}>
                  {(b.pnlPct ?? 0) !== 0 ? `${(b.pnlPct ?? 0) >= 0 ? '+' : ''}${(b.pnlPct ?? 0).toFixed(2)}%` : '—'}
                </td>
              )}
              <td>
                <div className="pct-bar">
                  <div className="pct-fill" style={{ width: `${Math.min(pct, 100)}%`, background: `linear-gradient(90deg, ${color}, ${color}99)` }}></div>
                  <span>{pct}%</span>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginBottom: '12px', cursor: 'pointer', color: '#94a3b8' }}>
        <input type="checkbox" checked={hideDust} onChange={e => setHideDust(e.target.checked)} />
        Hide assets under $1
      </label>

      {spotBalances.length > 0 && (
        <>
          {futuresBalances.length > 0 && <div className="table-section-label">Spot</div>}
          {renderTable(spotBalances, false)}
        </>
      )}
      {futuresBalances.length > 0 && (
        <>
          <div className="table-section-label" style={{ marginTop: '16px' }}>Futures Margin</div>
          {renderTable(futuresBalances, true)}
        </>
      )}
      {spotBalances.length === 0 && futuresBalances.length === 0 && (
        <div className="empty-state">All assets are under $1 — uncheck the filter to see them</div>
      )}
    </div>
  )
}
