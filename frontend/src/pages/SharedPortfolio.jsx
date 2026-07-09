import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import dayjs from 'dayjs'
import { API } from '../constants'
import { useCurrency } from '../context/CurrencyContext'

function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency()
  return (
    <div className="currency-toggle">
      <button className={currency === 'USD' ? 'active' : ''} onClick={() => setCurrency('USD')}>USD</button>
      <button className={currency === 'EUR' ? 'active' : ''} onClick={() => setCurrency('EUR')}>EUR</button>
    </div>
  )
}

export default function SharedPortfolio() {
  const { token } = useParams()
  const { formatMoney } = useCurrency()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    axios.get(`${API}/api/share/${token}`)
      .then(res => setData(res.data))
      .catch(e => setError(e.response?.data?.error || 'This link is invalid or has been revoked'))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) return <div className="page-loading">Loading...</div>

  if (error) {
    return (
      <div className="auth-overlay">
        <div className="auth-card">
          <div className="auth-logo">₿</div>
          <h1>Link unavailable</h1>
          <p className="auth-error">{error}</p>
          <Link to="/" className="btn-primary" style={{ textAlign: 'center', textDecoration: 'none', display: 'block', marginTop: '16px' }}>
            Go to assetfol.io
          </Link>
        </div>
      </div>
    )
  }

  const chartData = (data.snapshots || []).map(s => ({
    date: dayjs(s.date).format('DD/MM'),
    valor: parseFloat(s.value.toFixed(2))
  }))

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo" style={{ background: 'linear-gradient(135deg, #6366f1, #6366f199)' }}>₿</div>
          <div>
            <h1>Shared Portfolio</h1>
            <span className="subtitle">Read-only view · powered by assetfol.io</span>
          </div>
        </div>
        {data.showValues && <CurrencyToggle />}
      </header>

      <div className="stats">
        <div className="stat-card main">
          <span className="label">Total Value</span>
          <span className="value">{data.showValues ? formatMoney(data.totalUsdt) : '••••'}</span>
          <span className="badge" style={{ color: data.historicalPnlPct >= 0 ? '#22c55e' : '#ef4444' }}>
            {data.historicalPnlPct >= 0 ? '▲' : '▼'} {Math.abs(data.historicalPnlPct).toFixed(2)}% since start
          </span>
        </div>
        <div className="stat-card">
          <span className="label">Distribution</span>
          <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {Object.entries(data.breakdown || {}).map(([name, value]) => (
              <span key={name} style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                {name}: <span style={{ color: '#94a3b8' }}>{data.showValues ? formatMoney(value) : `${value.toFixed(1)}%`}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Portfolio Evolution</h2>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="grad-shared" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 12 }} />
            <YAxis stroke="#475569" tick={{ fontSize: 12 }} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={v => [data.showValues ? formatMoney(v) : `${v}%`, 'Value']}
            />
            <Area type="monotone" dataKey="valor" stroke="#6366f1" strokeWidth={2} fill="url(#grad-shared)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p style={{ textAlign: 'center', color: '#475569', fontSize: '13px', marginTop: '24px' }}>
        Powered by <Link to="/" style={{ color: '#6366f1' }}>assetfol.io</Link> — track your own portfolio for free
      </p>
    </div>
  )
}
