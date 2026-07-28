import dayjs from 'dayjs'
import { useCurrency } from '../context/CurrencyContext'

const SIDE_LABELS = {
  buy: { label: 'Buy', color: '#22c55e' },
  sell: { label: 'Sell', color: '#ef4444' },
  in: { label: 'Transfer In', color: '#22c55e' },
  out: { label: 'Transfer Out', color: '#ef4444' }
}

export default function TransactionsTable({ transactions, loading, isGlobal }) {
  const { formatMoney } = useCurrency()
  if (loading) return <div className="table-loading">Loading transactions...</div>
  if (!transactions.length) return <div className="empty-state">No transactions found</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Asset</th>
          {isGlobal && <th>Exchange</th>}
          <th>Type</th>
          <th>Price</th>
          <th>Quantity</th>
          <th>Value</th>
          <th>P&L $</th>
          <th>P&L %</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((t, i) => {
          const side = SIDE_LABELS[t.side] || { label: t.side, color: '#94a3b8' }
          const value = t.price ? t.qty * t.price : null
          return (
            <tr key={i}>
              <td style={{ fontSize: '12px', color: '#94a3b8' }}>{dayjs(t.date).format('DD MMM YYYY HH:mm')}</td>
              <td><span className="asset-badge" style={{ color: '#6366f1', background: '#6366f122' }}>{t.asset}</span></td>
              {isGlobal && <td style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>{t.exchange}</td>}
              <td style={{ color: side.color, fontWeight: 700 }}>{side.label}</td>
              <td>{t.price ? formatMoney(t.price, 4) : '—'}</td>
              <td>{t.qty.toFixed(6)}</td>
              <td>{value !== null ? formatMoney(value) : '—'}</td>
              <td style={{ color: (t.pnl ?? 0) > 0 ? '#22c55e' : (t.pnl ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: t.pnl ? 700 : 400 }}>
                {t.pnl !== null && t.pnl !== undefined ? `${t.pnl >= 0 ? '+' : ''}${formatMoney(t.pnl)}` : '—'}
              </td>
              <td style={{ color: (t.pnlPct ?? 0) > 0 ? '#22c55e' : (t.pnlPct ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: t.pnlPct ? 700 : 400 }}>
                {t.pnlPct !== null && t.pnlPct !== undefined ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%` : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
