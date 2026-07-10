import { useState, useEffect } from 'react'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import Calendar from 'react-calendar'
import dayjs from 'dayjs'
import 'react-calendar/dist/Calendar.css'
import { API, EXCHANGE_TYPES } from '../constants'
import { useCurrency } from '../context/CurrencyContext'
import PositionsTable from '../components/PositionsTable'
import SpotPositionsTable from '../components/SpotPositionsTable'
import BalancesTable from '../components/BalancesTable'
import TransactionsTable from '../components/TransactionsTable'
import SettingsModal from '../components/SettingsModal'
import AppNav from '../components/AppNav'

// Survives tab remounts (the Dashboard below is remounted on every tab switch via
// its `key` prop) so revisiting a tab shows the last-known data instantly instead
// of a fresh loading state, while fetches still refresh it in the background.
const dashboardCache = new Map()

// ─── Currency Toggle ──────────────────────────────────────
function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency()
  return (
    <div className="currency-toggle">
      <button className={currency === 'USD' ? 'active' : ''} onClick={() => setCurrency('USD')}>USD</button>
      <button className={currency === 'EUR' ? 'active' : ''} onClick={() => setCurrency('EUR')}>EUR</button>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────
function Dashboard({ exchange, isGlobal }) {
  const { formatMoney } = useCurrency()
  const exchangeId = isGlobal ? 'global' : exchange?.id
  const cached = dashboardCache.get(exchangeId)

  const [balances, setBalances] = useState(cached?.balances || [])
  const [positions, setPositions] = useState(cached?.positions || [])
  const [spotPositions, setSpotPositions] = useState(cached?.spotPositions || [])
  const [transactions, setTransactions] = useState(cached?.transactions || [])
  const [snapshots, setSnapshots] = useState(cached?.snapshots || [])
  const [totalUsdt, setTotalUsdt] = useState(cached?.totalUsdt || 0)
  const [breakdown, setBreakdown] = useState(cached?.breakdown || {})
  const [loadingBalances, setLoadingBalances] = useState(!cached?.balances)
  const [loadingPositions, setLoadingPositions] = useState(!cached?.positions)
  const [loadingSpot, setLoadingSpot] = useState(!cached?.spotPositions)
  const [loadingTransactions, setLoadingTransactions] = useState(!cached?.transactions)
  const [saving, setSaving] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(cached?.lastUpdated || null)
  const [balanceError, setBalanceError] = useState(null)

  const exchangeType = isGlobal ? 'global' : exchange?.type
  const color = EXCHANGE_TYPES[exchangeType]?.color || '#6366f1'

  function updateCache(patch) {
    dashboardCache.set(exchangeId, { ...dashboardCache.get(exchangeId), ...patch })
  }

  const accountUrl = isGlobal ? `${API}/api/global/account` : `${API}/api/exchange/${exchangeId}/account`
  const positionsUrl = isGlobal ? `${API}/api/global/positions` : `${API}/api/exchange/${exchangeId}/positions`
  const spotPositionsUrl = isGlobal ? `${API}/api/global/spot-positions` : `${API}/api/exchange/${exchangeId}/spot-positions`
  const transactionsUrl = isGlobal ? `${API}/api/global/transactions` : `${API}/api/exchange/${exchangeId}/transactions`

  async function fetchBalances() {
    try {
      const res = await axios.get(accountUrl)
      const balances = res.data.balances || []
      const totalUsdt = res.data.totalUsdt || 0
      const breakdown = res.data.breakdown || {}
      const lastUpdated = new Date()
      setBalances(balances)
      setTotalUsdt(totalUsdt)
      setBreakdown(breakdown)
      setLastUpdated(lastUpdated)
      setBalanceError(null)
      updateCache({ balances, totalUsdt, breakdown, lastUpdated })
    } catch (e) {
      console.error('Balance error:', e.message)
      setBalanceError(e.response?.data?.error || e.message || 'Failed to load balances')
    } finally {
      setLoadingBalances(false)
    }
  }

  async function fetchPositions() {
    try {
      const res = await axios.get(positionsUrl)
      const positions = res.data || []
      setPositions(positions)
      updateCache({ positions })
    } catch (e) {
      console.error('Positions error:', e.message)
    } finally {
      setLoadingPositions(false)
    }
  }

  async function fetchSpotPositions() {
    try {
      const res = await axios.get(spotPositionsUrl)
      const spotPositions = res.data || []
      setSpotPositions(spotPositions)
      updateCache({ spotPositions })
    } catch (e) {
      console.error('Spot positions error:', e.message)
    } finally {
      setLoadingSpot(false)
    }
  }

  async function fetchTransactions() {
    try {
      const res = await axios.get(transactionsUrl)
      const transactions = res.data || []
      setTransactions(transactions)
      updateCache({ transactions })
    } catch (e) {
      console.error('Transactions error:', e.message)
    } finally {
      setLoadingTransactions(false)
    }
  }

  async function fetchSnapshots() {
    try {
      const res = await axios.get(`${API}/api/snapshots/${exchangeId}`)
      const snapshots = res.data || []
      setSnapshots(snapshots)
      updateCache({ snapshots })
    } catch (e) { console.error('Snapshots error:', e.message) }
  }

  async function saveSnapshot() {
    setSaving(true)
    try {
      await axios.post(`${API}/api/snapshot`, { exchangeId })
      await fetchSnapshots()
    } catch (e) { alert(e.response?.data?.error || 'Error saving snapshot') }
    finally { setSaving(false) }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount + polling, not derivable from render
    fetchBalances()
    fetchPositions()
    fetchSpotPositions()
    fetchTransactions()
    fetchSnapshots()

    const balancesInterval = setInterval(fetchBalances, 60000)
    const positionsInterval = setInterval(fetchPositions, 15000)
    const spotInterval = setInterval(fetchSpotPositions, 60000)
    const transactionsInterval = setInterval(fetchTransactions, 60000)

    return () => {
      clearInterval(balancesInterval)
      clearInterval(positionsInterval)
      clearInterval(spotInterval)
      clearInterval(transactionsInterval)
    }
  }, [exchangeId])

  function getPnlForDate(date) {
    const dateStr = dayjs(date).format('YYYY-MM-DD')
    const idx = snapshots.findIndex(s => s.date === dateStr)
    if (idx <= 0) return null
    return parseFloat(snapshots[idx].total_value_usdt) - parseFloat(snapshots[idx - 1].total_value_usdt)
  }

  function tileContent({ date }) {
    const pnl = getPnlForDate(date)
    if (pnl === null) return null
    const c = pnl >= 0 ? '#22c55e' : '#ef4444'
    return <div style={{ fontSize: '9px', color: c, fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}{formatMoney(pnl)}</div>
  }

  function tileClassName({ date }) {
    const pnl = getPnlForDate(date)
    if (pnl === null) return null
    return pnl >= 0 ? 'day-profit' : 'day-loss'
  }

  const chartData = snapshots.map(s => ({
    date: dayjs(s.date).format('DD/MM'),
    valor: parseFloat(parseFloat(s.total_value_usdt).toFixed(2))
  }))

  const firstValue = snapshots.length > 0 ? parseFloat(snapshots[0].total_value_usdt) : 0
  const totalPnl = totalUsdt - firstValue
  const totalPnlPct = firstValue > 0 ? ((totalPnl / firstValue) * 100).toFixed(2) : 0
  const today = new Date().toISOString().split('T')[0]
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const prevSnapshot = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null
  const todayPnl = lastSnapshot && prevSnapshot
    ? parseFloat(lastSnapshot.total_value_usdt) - parseFloat(prevSnapshot.total_value_usdt)
    : 0
  const todayPnlLabel = lastSnapshot?.date === today ? 'vs yesterday' : lastSnapshot?.date ? `vs ${prevSnapshot?.date || '—'}` : 'no snapshots'
  const totalFuturesPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
  const totalSpotPnl = spotPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)

  return (
    <div>
      {balanceError && (
        <div className="error-banner">
          Connection error: {balanceError}
        </div>
      )}
      <div className="stats">
        <div className="stat-card main" style={{ borderColor: `${color}33` }}>
          <span className="label">Total Value</span>
          <span className="value">{formatMoney(totalUsdt)}</span>
          <span className="badge" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalPnl >= 0 ? '▲' : '▼'} {Math.abs(totalPnlPct)}% since start
          </span>
        </div>
        <div className="stat-card">
          <span className="label">Historical P&L</span>
          <span className="value" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalPnl >= 0 ? '+' : ''}{formatMoney(totalPnl)}
          </span>
          <span className="badge">since first snapshot</span>
        </div>
        <div className="stat-card">
          <span className="label">Futures P&L (open)</span>
          <span className="value" style={{ color: totalFuturesPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalFuturesPnl >= 0 ? '+' : ''}{formatMoney(totalFuturesPnl)}
          </span>
          <span className="badge">{positions.length} positions • ↻ 15s</span>
        </div>
        <div className="stat-card">
          <span className="label">Spot P&L</span>
          <span className="value" style={{ color: totalSpotPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalSpotPnl !== 0 ? `${totalSpotPnl >= 0 ? '+' : ''}${formatMoney(totalSpotPnl)}` : '—'}
          </span>
          <span className="badge">{spotPositions.length} holdings • ↻ 60s</span>
        </div>
        {isGlobal ? (
          <div className="stat-card">
            <span className="label">Distribution</span>
            <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {Object.entries(breakdown).map(([name, value]) => (
                <span key={name} style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                  {name}: <span style={{ color: '#94a3b8' }}>{formatMoney(value)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="stat-card">
            <span className="label">Today's P&L</span>
            <span className="value" style={{ color: todayPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {todayPnl >= 0 ? '+' : ''}{formatMoney(todayPnl)}
            </span>
            <span className="badge">{todayPnlLabel}</span>
          </div>
        )}
      </div>

      <div className="main-grid">
        <div className="card">
          <div className="card-header">
            <h2>Account Evolution</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {lastUpdated && <span className="update-time">↻ {dayjs(lastUpdated).format('HH:mm:ss')}</span>}
              <button className="btn-snapshot" onClick={saveSnapshot} disabled={saving}>
                {saving ? '...' : '+ Snapshot'}

              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id={`grad-${exchangeId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 12 }} />
              <YAxis stroke="#475569" tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }} labelStyle={{ color: '#94a3b8' }} formatter={v => [formatMoney(v), 'Value']} />
              <Area type="monotone" dataKey="valor" stroke={color} strokeWidth={2} fill={`url(#grad-${exchangeId})`} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>P&L Calendar</h2>
            <div className="legend">
              <span className="legend-item profit">● Profit</span>
              <span className="legend-item loss">● Loss</span>
            </div>
          </div>
          <Calendar tileContent={tileContent} tileClassName={tileClassName} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Open Positions — Futures</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {positions.length} positions • ↻ 15s
          </span>
        </div>
        <PositionsTable positions={positions} loading={loadingPositions} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Open Positions — Spot</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {spotPositions.length} holdings • ↻ 60s
          </span>
        </div>
        <SpotPositionsTable positions={spotPositions} loading={loadingSpot} isGlobal={isGlobal} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Wallet Balances</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {balances.length} assets • ↻ 60s
          </span>
        </div>
        <BalancesTable balances={balances} totalUsdt={totalUsdt} isGlobal={isGlobal} loading={loadingBalances} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Transaction History</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {transactions.length} transactions • ↻ 60s
          </span>
        </div>
        <TransactionsTable transactions={transactions} loading={loadingTransactions} isGlobal={isGlobal} />
      </div>
    </div>
  )
}

// ─── Dashboard Page ────────────────────────────────────────
export default function DashboardPage({ onLogout }) {
  const [exchanges, setExchanges] = useState([])
  const [activeTab, setActiveTab] = useState('global')
  const [showSettings, setShowSettings] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  async function fetchExchanges() {
    try {
      const res = await axios.get(`${API}/api/exchanges`)
      setExchanges(res.data)
      setRefreshKey(k => k + 1)
      if (res.data.length === 0) setShowSettings(true)
      setActiveTab(tab => {
        if (tab !== 'global' && !res.data.find(e => e.id === tab)) return 'global'
        return tab
      })
    } catch (e) { console.error(e) }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount
  useEffect(() => { fetchExchanges() }, [])

  const activeExchange = exchanges.find(e => e.id === activeTab)
  const isGlobal = activeTab === 'global'
  const color = isGlobal ? '#6366f1' : EXCHANGE_TYPES[activeExchange?.type]?.color || '#6366f1'

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo" style={{ background: `linear-gradient(135deg, ${color}, ${color}99)` }}>₿</div>
          <div>
            <h1>Crypto Dashboard</h1>
            <span className="subtitle">{dayjs().format('DD MMM YYYY')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <CurrencyToggle />
          <button className="btn-settings" onClick={() => setShowSettings(true)}>⚙️ Settings</button>
          <button className="btn-settings" onClick={onLogout} style={{ color: '#ef4444', borderColor: '#ef444433' }}>Logout</button>
        </div>
      </header>

      <AppNav />

      <div className="tabs">
        <button
          className={`tab ${isGlobal ? 'active' : ''}`}
          style={isGlobal ? { borderColor: '#6366f1', color: '#6366f1' } : {}}
          onClick={() => setActiveTab('global')}>
          Global
        </button>
        {exchanges.map(ex => (
          <button key={ex.id}
            className={`tab ${activeTab === ex.id ? 'active' : ''}`}
            style={activeTab === ex.id ? { borderColor: EXCHANGE_TYPES[ex.type]?.color, color: EXCHANGE_TYPES[ex.type]?.color } : {}}
            onClick={() => setActiveTab(ex.id)}>
            {ex.name}
          </button>
        ))}
        <button className="tab tab-add" onClick={() => setShowSettings(true)}>+ Exchange</button>
      </div>

      {(isGlobal || activeExchange) ? (
        <Dashboard key={`${activeTab}-${refreshKey}`} exchange={activeExchange} isGlobal={isGlobal} />
      ) : (
        <div className="empty-dashboard">
          <p>No exchange configured.</p>
          <button className="btn-primary" onClick={() => setShowSettings(true)}>Configure now</button>
        </div>
      )}

      {showSettings && (
        <SettingsModal onUpdate={fetchExchanges} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
