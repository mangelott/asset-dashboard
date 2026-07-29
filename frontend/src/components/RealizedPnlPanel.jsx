import { useState, useEffect } from 'react'
import axios from 'axios'
import dayjs from 'dayjs'
import { API } from '../constants'
import { useCurrency } from '../context/CurrencyContext'

export default function RealizedPnlPanel({ exchangeId, isGlobal }) {
  const { formatMoney } = useCurrency()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const url = isGlobal
    ? `${API}/api/global/realized-pnl`
    : `${API}/api/exchange/${exchangeId}/realized-pnl`

  useEffect(() => {
    setLoading(true)
    axios.get(url)
      .then(r => { setData(r.data); setError(null) })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false))
  }, [exchangeId])

  if (loading) return <div className="table-loading">A carregar histórico de trades...</div>
  if (error) return <div className="error-banner">{error}</div>
  if (!data || !data.stats || data.stats.tradeCount === 0) return (
    <div className="empty-state">Sem trades realizados disponíveis para esta conta.</div>
  )

  const { stats, trades } = data
  const byAssetSorted = Object.entries(stats.byAsset || {})
    .sort((a, b) => b[1].pnl - a[1].pnl)

  return (
    <div className="realized-pnl-panel">
      <div className="rpnl-stats">
        <div className="rpnl-stat-card">
          <span className="label">P&L Realizado Total</span>
          <span className="value" style={{ color: stats.totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {formatMoney(stats.totalPnl)}
          </span>
        </div>
        <div className="rpnl-stat-card">
          <span className="label">Win Rate</span>
          <span className="value" style={{ color: stats.winRate >= 50 ? '#22c55e' : '#ef4444' }}>
            {stats.winRate.toFixed(1)}%
          </span>
          <span className="badge">{stats.winCount}W / {stats.lossCount}L</span>
        </div>
        <div className="rpnl-stat-card">
          <span className="label">Melhor Trade</span>
          <span className="value" style={{ color: '#22c55e' }}>
            {stats.best ? formatMoney(stats.best.pnl) : '—'}
          </span>
          {stats.best && <span className="badge">{stats.best.asset} · {dayjs(stats.best.date).format('DD/MM/YY')}</span>}
        </div>
        <div className="rpnl-stat-card">
          <span className="label">Pior Trade</span>
          <span className="value" style={{ color: '#ef4444' }}>
            {stats.worst ? formatMoney(stats.worst.pnl) : '—'}
          </span>
          {stats.worst && <span className="badge">{stats.worst.asset} · {dayjs(stats.worst.date).format('DD/MM/YY')}</span>}
        </div>
        <div className="rpnl-stat-card">
          <span className="label">Média Win / Loss</span>
          <span className="value" style={{ fontSize: '16px' }}>
            <span style={{ color: '#22c55e' }}>{formatMoney(stats.avgWin)}</span>
            {' / '}
            <span style={{ color: '#ef4444' }}>{formatMoney(stats.avgLoss)}</span>
          </span>
        </div>
      </div>

      {byAssetSorted.length > 0 && (
        <div className="rpnl-by-asset">
          <h4>Por Asset</h4>
          <table>
            <thead><tr><th>Asset</th><th>P&L Realizado</th><th>Wins</th><th>Losses</th></tr></thead>
            <tbody>
              {byAssetSorted.map(([asset, s]) => (
                <tr key={asset}>
                  <td><strong>{asset}</strong></td>
                  <td style={{ color: s.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {formatMoney(s.pnl)}
                  </td>
                  <td style={{ color: '#22c55e' }}>{s.wins}</td>
                  <td style={{ color: '#ef4444' }}>{s.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trades.length > 0 && (
        <div className="rpnl-trades">
          <h4>Trades Recentes</h4>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Asset</th>
                  {isGlobal && <th>Exchange</th>}
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Preço</th>
                  <th>P&L</th>
                  <th>P&L %</th>
                </tr>
              </thead>
              <tbody>
                {trades.filter(t => t.pnl !== null).slice(0, 50).map((t, i) => (
                  <tr key={i}>
                    <td>{dayjs(t.date).format('DD/MM/YY HH:mm')}</td>
                    <td><strong>{t.asset}</strong></td>
                    {isGlobal && <td>{t.exchangeName || '—'}</td>}
                    <td style={{ color: t.side === 'buy' ? '#22c55e' : '#f59e0b', textTransform: 'uppercase', fontWeight: 600, fontSize: '11px' }}>{t.side}</td>
                    <td>{(t.qty ?? 0).toFixed(4)}</td>
                    <td>${(t.price ?? 0).toFixed(4)}</td>
                    <td style={{ color: t.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                      {formatMoney(t.pnl)}
                    </td>
                    <td style={{ color: (t.pnlPct ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                      {t.pnlPct !== null && t.pnlPct !== undefined ? `${t.pnlPct.toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
