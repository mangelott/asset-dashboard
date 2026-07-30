import { useState, useEffect, useRef } from 'react'
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
import RealizedPnlPanel from '../components/RealizedPnlPanel'

const dashboardCache = new Map()

function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency()
  return (
    <div className="currency-toggle">
      <button className={currency === 'USD' ? 'active' : ''} onClick={() => setCurrency('USD')}>USD</button>
      <button className={currency === 'EUR' ? 'active' : ''} onClick={() => setCurrency('EUR')}>EUR</button>
    </div>
  )
}

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
  const [netDeposits, setNetDeposits] = useState(null)
  const [activeTab, setActiveTab] = useState('balances')
  const [benchmark, setBenchmark] = useState(null)
  const [showBenchmark, setShowBenchmark] = useState(false)
  const [intradaySnapshots, setIntradaySnapshots] = useState([])
  const [chartMode, setChartMode] = useState('daily')

  const exchangeType = isGlobal ? 'global' : exchange?.type
  const color = EXCHANGE_TYPES[exchangeType]?.color || '#6366f1'

  function updateCache(patch) {
    dashboardCache.set(exchangeId, { ...dashboardCache.get(exchangeId), ...patch })
  }

  const accountUrl = isGlobal ? `${API}/api/global/account` : `${API}/api/exchange/${exchangeId}/account`
  const depositsUrl = isGlobal ? `${API}/api/global/net-deposits` : `${API}/api/exchange/${exchangeId}/net-deposits`
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
      setBalanceError(e.response?.data?.error || e.message || 'Erro ao carregar saldos')
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

  async function fetchNetDeposits(since) {
    try {
      const url = since ? `${depositsUrl}?since=${since}` : depositsUrl
      const res = await axios.get(url)
      setNetDeposits(res.data?.totalDeposits ?? 0)
    } catch (e) {
      console.error('Deposits error:', e.message)
      setNetDeposits(0)
    }
  }

  async function fetchSnapshots() {
    try {
      const res = await axios.get(`${API}/api/snapshots/${exchangeId}`)
      const snapshots = res.data || []
      setSnapshots(snapshots)
      updateCache({ snapshots })
      if (snapshots.length > 0) fetchNetDeposits(snapshots[0].date)
      if (snapshots.length > 0) fetchBenchmark(snapshots[0].date)
    } catch (e) { console.error('Snapshots error:', e.message) }
  }

  async function fetchBenchmark(sinceDate) {
    try {
      const from = sinceDate || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().split('T')[0]
      const res = await axios.get(`${API}/api/benchmark?from=${from}`)
      setBenchmark(res.data)
    } catch (e) { console.error('Benchmark error:', e.message) }
  }

  async function fetchIntradaySnapshots() {
    try {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      const res = await axios.get(`${API}/api/intraday-snapshots/${exchangeId}?since=${since}`)
      setIntradaySnapshots(res.data || [])
    } catch (e) { console.error('Intraday snapshots error:', e.message) }
  }

  async function saveSnapshot() {
    setSaving(true)
    try {
      await axios.post(`${API}/api/snapshot`, { exchangeId })
      await fetchSnapshots()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao guardar snapshot') }
    finally { setSaving(false) }
  }

  useEffect(() => {
    fetchBalances()
    fetchPositions()
    fetchSpotPositions()
    fetchTransactions()
    fetchSnapshots()
    fetchIntradaySnapshots()

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
    return (
      <div className="cal-tile-pnl">
        <span className="cal-dot" style={{ background: c }} />
        <span className="cal-tip" style={{ color: c }}>{formatMoney(pnl)}</span>
      </div>
    )
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

  const intradayChartData = intradaySnapshots.map(s => ({
    date: dayjs(s.recorded_at).format('DD/MM HH:mm'),
    valor: parseFloat(parseFloat(s.total_value_usdt).toFixed(2))
  }))

  const activeChartData = chartMode === 'intraday' && intradayChartData.length > 0
    ? intradayChartData
    : chartData

  const firstValue = snapshots.length > 0 ? parseFloat(snapshots[0].total_value_usdt) : 0

  const benchmarkChartData = (() => {
    if (!benchmark || !showBenchmark || chartData.length === 0) return []
    const firstDate = snapshots[0]?.date
    if (!firstDate) return []
    const btcData = benchmark['BTCUSDT'] || []
    const ethData = benchmark['ETHUSDT'] || []
    const btcFirst = btcData.find(d => d.date >= firstDate)?.close || btcData[0]?.close
    const ethFirst = ethData.find(d => d.date >= firstDate)?.close || ethData[0]?.close
    const btcMap = Object.fromEntries(btcData.map(d => [d.date, d.close]))
    const ethMap = Object.fromEntries(ethData.map(d => [d.date, d.close]))
    return chartData.map((d, i) => {
      const dateKey = snapshots[i]?.date
      return {
        ...d,
        btc: btcFirst && btcMap[dateKey] ? (btcMap[dateKey] / btcFirst) * firstValue : undefined,
        eth: ethFirst && ethMap[dateKey] ? (ethMap[dateKey] / ethFirst) * firstValue : undefined
      }
    })
  })()

  const finalChartData = showBenchmark && benchmarkChartData.length > 0 ? benchmarkChartData : activeChartData

  const deposits = netDeposits ?? 0
  const totalPnl = totalUsdt - firstValue - deposits
  const totalPnlPct = firstValue > 0 ? ((totalPnl / (firstValue + deposits)) * 100).toFixed(2) : 0
  const today = new Date().toISOString().split('T')[0]
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const prevSnapshot = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null
  const todayPnl = lastSnapshot && prevSnapshot
    ? parseFloat(lastSnapshot.total_value_usdt) - parseFloat(prevSnapshot.total_value_usdt)
    : 0
  const todayPnlLabel = lastSnapshot?.date === today ? 'vs ontem' : lastSnapshot?.date ? `vs ${prevSnapshot?.date || '—'}` : 'sem snapshots'
  const totalFuturesPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
  const totalSpotPnl = spotPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)

  const hasFutures = !loadingPositions && positions.length > 0
  const hasSpotPnl = !loadingSpot && totalSpotPnl !== 0

  return (
    <div>
      {balanceError && (
        <div className="error-banner">
          Erro de ligação: {balanceError}
        </div>
      )}
      <div className="stats">
        <div className="stat-card main" style={{ borderColor: `${color}33` }}>
          <span className="label">Valor Total</span>
          <span className="value">{formatMoney(totalUsdt)}</span>
          <span className="badge" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalPnl >= 0 ? '▲' : '▼'} {Math.abs(totalPnlPct)}% desde o início
          </span>
        </div>
        <div className="stat-card">
          <span className="label">P&L Histórico</span>
          <span className="value" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {netDeposits === null ? '...' : formatMoney(totalPnl)}
          </span>
          <span className="badge">
            {netDeposits === null ? 'a calcular...' : deposits > 0 ? `excl. ${deposits.toFixed(0)}$ depositados` : 'desde o 1º snapshot'}
          </span>
        </div>
        {!isGlobal && (
          <div className="stat-card">
            <span className="label">P&L Hoje</span>
            <span className="value" style={{ color: todayPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {formatMoney(todayPnl)}
            </span>
            <span className="badge">{todayPnlLabel}</span>
          </div>
        )}
        {hasFutures && (
          <div className="stat-card">
            <span className="label">P&L Futuros</span>
            <span className="value" style={{ color: totalFuturesPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {formatMoney(totalFuturesPnl)}
            </span>
            <span className="badge">{positions.length} {positions.length === 1 ? 'posição' : 'posições'} • ↻ 15s</span>
          </div>
        )}
        {hasSpotPnl && (
          <div className="stat-card">
            <span className="label">P&L Spot</span>
            <span className="value" style={{ color: totalSpotPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {formatMoney(totalSpotPnl)}
            </span>
            <span className="badge">{spotPositions.length} {spotPositions.length === 1 ? 'activo' : 'activos'} • ↻ 60s</span>
          </div>
        )}
        {isGlobal && (
          <div className="stat-card">
            <span className="label">Distribuição</span>
            <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {Object.entries(breakdown).map(([name, value]) => (
                <span key={name} style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                  {name}: <span style={{ color: '#94a3b8' }}>{formatMoney(value)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="main-grid">
        <div className="card">
          <div className="card-header">
            <h2>Evolução do Portfolio</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {lastUpdated && <span className="update-time">↻ {dayjs(lastUpdated).format('HH:mm:ss')}</span>}
              <button className="btn-snapshot" onClick={saveSnapshot} disabled={saving}>
                {saving ? '...' : '+ Snapshot'}
              </button>
            </div>
          </div>
          <div className="chart-header">
            <div className="chart-toggles">
              <button className={chartMode === 'daily' ? 'active' : ''} onClick={() => setChartMode('daily')}>Diário</button>
              {intradaySnapshots.length > 0 && (
                <button className={chartMode === 'intraday' ? 'active' : ''} onClick={() => setChartMode('intraday')}>Horário</button>
              )}
            </div>
            <div className="chart-toggles">
              <button
                className={showBenchmark ? 'active' : ''}
                onClick={() => { setShowBenchmark(v => !v); if (!benchmark) fetchBenchmark(snapshots[0]?.date) }}
              >vs BTC / ETH</button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={finalChartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <defs>
                <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#18181f" />
              <XAxis dataKey="date" tick={{ fill: '#475569', fontSize: 10 }} />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} width={60} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ background: '#0f0f17', border: '1px solid #18181f', borderRadius: '8px', fontSize: '12px' }}
                formatter={(value, name) => {
                  if (name === 'valor') return [`$${value.toLocaleString()}`, 'Portfolio']
                  if (name === 'btc') return [`$${value?.toLocaleString()}`, 'BTC (norm.)']
                  if (name === 'eth') return [`$${value?.toLocaleString()}`, 'ETH (norm.)']
                  return [value, name]
                }}
              />
              <Area type="monotone" dataKey="valor" stroke="#6366f1" fill="url(#colorVal)" dot={false} strokeWidth={2} />
              {showBenchmark && <Area type="monotone" dataKey="btc" stroke="#f59e0b" fill="none" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
              {showBenchmark && <Area type="monotone" dataKey="eth" stroke="#627eea" fill="none" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Calendário P&L</h2>
            <div className="legend">
              <span className="legend-item profit">● Lucro</span>
              <span className="legend-item loss">● Perda</span>
            </div>
          </div>
          <Calendar tileContent={tileContent} tileClassName={tileClassName} />
        </div>
      </div>

      <div className="tabs" style={{ marginTop: '8px' }}>
        <button className={`tab ${activeTab === 'balances' ? 'active' : ''}`} onClick={() => setActiveTab('balances')}>Saldos</button>
        <button className={`tab ${activeTab === 'positions' ? 'active' : ''}`} onClick={() => setActiveTab('positions')}>Futuros</button>
        <button className={`tab ${activeTab === 'spot' ? 'active' : ''}`} onClick={() => setActiveTab('spot')}>Spot</button>
        <button className={`tab ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>Histórico</button>
        <button className={`tab ${activeTab === 'realized' ? 'active' : ''}`} onClick={() => setActiveTab('realized')}>P&L Realizado</button>
      </div>

      {activeTab === 'positions' && (
        <div className="card">
          <div className="card-header">
            <h2>Posições Abertas — Futuros</h2>
            <span className="tag" style={{ color, background: `${color}22` }}>
              {positions.length} {positions.length === 1 ? 'posição' : 'posições'} • ↻ 15s
            </span>
          </div>
          <PositionsTable positions={positions} loading={loadingPositions} />
        </div>
      )}

      {activeTab === 'spot' && (
        <div className="card">
          <div className="card-header">
            <h2>Posições Abertas — Spot</h2>
            <span className="tag" style={{ color, background: `${color}22` }}>
              {spotPositions.length} {spotPositions.length === 1 ? 'activo' : 'activos'} • ↻ 60s
            </span>
          </div>
          <SpotPositionsTable positions={spotPositions} loading={loadingSpot} isGlobal={isGlobal} />
        </div>
      )}

      {activeTab === 'balances' && (
        <div className="card">
          <div className="card-header">
            <h2>Saldos</h2>
            <span className="tag" style={{ color, background: `${color}22` }}>
              {balances.length} {balances.length === 1 ? 'activo' : 'activos'} • ↻ 60s
            </span>
          </div>
          <BalancesTable balances={balances} totalUsdt={totalUsdt} isGlobal={isGlobal} loading={loadingBalances} />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="card">
          <div className="card-header">
            <h2>Histórico de Trades</h2>
            <span className="tag" style={{ color, background: `${color}22` }}>
              {transactions.length} {transactions.length === 1 ? 'transação' : 'transações'} • ↻ 60s
            </span>
          </div>
          <TransactionsTable transactions={transactions} loading={loadingTransactions} isGlobal={isGlobal} />
        </div>
      )}

      {activeTab === 'realized' && (
        <div className="card">
          <div className="card-header">
            <h2>P&L Realizado</h2>
          </div>
          <RealizedPnlPanel exchangeId={exchangeId} isGlobal={isGlobal} />
        </div>
      )}
    </div>
  )
}

export default function DashboardPage({ onLogout }) {
  const [exchanges, setExchanges] = useState([])
  const [activeTab, setActiveTab] = useState('global')
  const [showSettings, setShowSettings] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef(null)

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

  useEffect(() => { fetchExchanges() }, [])

  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false)
      }
    }
    if (showUserMenu) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showUserMenu])

  const activeExchange = exchanges.find(e => e.id === activeTab)
  const isGlobal = activeTab === 'global'
  const color = isGlobal ? '#6366f1' : EXCHANGE_TYPES[activeExchange?.type]?.color || '#6366f1'

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo" style={{ background: `linear-gradient(135deg, ${color}, ${color}99)` }}>₿</div>
          <div>
            <h1>Asset Dashboard</h1>
            <span className="subtitle">{dayjs().format('DD MMM YYYY')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <CurrencyToggle />
          <div className="user-menu-wrap" ref={userMenuRef}>
            <button className="btn-user-menu" onClick={() => setShowUserMenu(v => !v)}>☰</button>
            {showUserMenu && (
              <div className="user-menu-dropdown">
                <button onMouseDown={() => { setShowSettings(true); setShowUserMenu(false) }}>⚙️ Definições</button>
                <button onMouseDown={onLogout} className="user-menu-logout">Sair</button>
              </div>
            )}
          </div>
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
          <p>Nenhuma exchange configurada.</p>
          <button className="btn-primary" onClick={() => setShowSettings(true)}>Configurar agora</button>
        </div>
      )}

      {showSettings && (
        <SettingsModal onUpdate={fetchExchanges} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
