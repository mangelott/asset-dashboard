import { useState } from 'react'
import dayjs from 'dayjs'
import { useCurrency } from '../context/CurrencyContext'

const SIDE_LABELS = {
  buy: { label: 'Compra', color: '#22c55e' },
  sell: { label: 'Venda', color: '#f59e0b' },
  in: { label: 'Entrada', color: '#22c55e' },
  out: { label: 'Saída', color: '#ef4444' }
}

export default function TransactionsTable({ transactions, loading, isGlobal }) {
  const { formatMoney } = useCurrency()
  const [filter, setFilter] = useState('all')

  if (loading) return <div className="table-loading">A carregar histórico...</div>
  if (!transactions.length) return <div className="empty-state">Sem transações</div>

  const filtered = filter === 'all' ? transactions : transactions.filter(t => t.side === filter)

  return (
    <div>
      <div className="history-filter">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todos</button>
        <button className={filter === 'buy' ? 'active' : ''} onClick={() => setFilter('buy')}>Compras</button>
        <button className={filter === 'sell' ? 'active' : ''} onClick={() => setFilter('sell')}>Vendas</button>
      </div>
      {filter === 'buy' && (
        <p className="history-note">As compras não têm P&L realizado — o lucro/perda é calculado no momento da venda.</p>
      )}
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Activo</th>
            {isGlobal && <th>Exchange</th>}
            <th>Tipo</th>
            <th>Preço</th>
            <th>Quantidade</th>
            <th>Valor</th>
            <th>P&L</th>
            <th>P&L %</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t, i) => {
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
                  {t.pnl !== null && t.pnl !== undefined ? formatMoney(t.pnl) : '—'}
                </td>
                <td style={{ color: (t.pnlPct ?? 0) > 0 ? '#22c55e' : (t.pnlPct ?? 0) < 0 ? '#ef4444' : '#64748b', fontWeight: t.pnlPct ? 700 : 400 }}>
                  {t.pnlPct !== null && t.pnlPct !== undefined ? `${t.pnlPct.toFixed(2)}%` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
