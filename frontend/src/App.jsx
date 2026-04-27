import { useState, useEffect } from 'react'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import Calendar from 'react-calendar'
import dayjs from 'dayjs'
import 'react-calendar/dist/Calendar.css'
import './App.css'

const API = 'http://localhost:3001'

const EXCHANGE_TYPES = {
  binance: { label: 'Binance', color: '#f59e0b' },
  bybit: { label: 'Bybit', color: '#14b8a6' },
  coinbase: { label: 'Coinbase', color: '#0052ff' },
  kraken: { label: 'Kraken', color: '#5741d9' },
  okx: { label: 'OKX', color: '#e6f0ff' },
  wallet_eth: { label: 'Wallet ETH', color: '#627eea' },
  global: { label: 'Global', color: '#6366f1' }
}

// ─── Positions Table ──────────────────────────────────────
function PositionsTable({ positions, loading }) {
  if (loading) return <div className="table-loading">A carregar posições...</div>
  if (!positions.length) return <div className="empty-state">Sem posições abertas</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Par</th>
          {positions[0]?.exchange && <th>Exchange</th>}
          <th>Direção</th>
          <th>Tamanho</th>
          <th>Preço Entrada</th>
          <th>Preço Atual</th>
          <th>P&L $</th>
          <th>P&L %</th>
          <th>Liq. Price</th>
          <th>Alavancagem</th>
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
            <td>${p.entryPrice.toFixed(4)}</td>
            <td>${p.markPrice.toFixed(4)}</td>
            <td style={{ color: p.pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {p.pnl >= 0 ? '+' : ''}{p.pnl.toFixed(2)}$
            </td>
            <td style={{ color: p.pnlPct >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {p.pnlPct >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%
            </td>
            <td style={{ color: '#ef4444' }}>${p.liquidationPrice?.toFixed(2) || '—'}</td>
            <td><span className="leverage-badge">{p.leverage}x</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Balances Table ───────────────────────────────────────
function BalancesTable({ balances, totalUsdt, isGlobal, loading }) {
  if (loading) return <div className="table-loading">A carregar saldos...</div>
  if (!balances.length) return <div className="empty-state">Sem saldos disponíveis</div>

  const spotBalances = balances.filter(b => b.type === 'Spot' || !b.type)
  const futuresBalances = balances.filter(b => b.type === 'Futures')

  const renderTable = (items, isFutures) => (
    <table>
      <thead>
        <tr>
          <th>Moeda</th>
          {isGlobal && <th>Exchange</th>}
          <th>Quantidade</th>
          {!isFutures && <th>Preço Médio</th>}
          {!isFutures && <th>Preço Atual</th>}
          <th>Valor (USDT)</th>
          {!isFutures && <th>P&L $</th>}
          {!isFutures && <th>P&L %</th>}
          <th>% Carteira</th>
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
              {!isFutures && <td>{b.avgEntryPrice > 0 ? `$${b.avgEntryPrice.toFixed(4)}` : '—'}</td>}
              {!isFutures && <td>{b.currentPrice > 0 ? `$${b.currentPrice.toFixed(4)}` : '—'}</td>}
              <td><strong>${b.valueUsdt.toFixed(2)}</strong></td>
              {!isFutures && (
                <td style={{ color: b.pnl > 0 ? '#22c55e' : b.pnl < 0 ? '#ef4444' : '#64748b', fontWeight: b.pnl !== 0 ? 700 : 400 }}>
                  {b.pnl !== 0 ? `${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}$` : '—'}
                </td>
              )}
              {!isFutures && (
                <td style={{ color: b.pnlPct > 0 ? '#22c55e' : b.pnlPct < 0 ? '#ef4444' : '#64748b', fontWeight: b.pnlPct !== 0 ? 700 : 400 }}>
                  {b.pnlPct !== 0 ? `${b.pnlPct >= 0 ? '+' : ''}${b.pnlPct.toFixed(2)}%` : '—'}
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
      {spotBalances.length > 0 && (
        <>
          {futuresBalances.length > 0 && <div className="table-section-label">Spot</div>}
          {renderTable(spotBalances, false)}
        </>
      )}
      {futuresBalances.length > 0 && (
        <>
          <div className="table-section-label" style={{ marginTop: '16px' }}>Margem Futures</div>
          {renderTable(futuresBalances, true)}
        </>
      )}
    </div>
  )
}

// ─── Settings Modal ───────────────────────────────────────
function SettingsModal({ onClose, onUpdate }) {
  const [exchanges, setExchanges] = useState([])
  const [form, setForm] = useState({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { fetchExchanges() }, [])

  async function fetchExchanges() {
    try {
      const res = await axios.get(`${API}/api/exchanges`)
      setExchanges(res.data)
    } catch (e) { console.error(e) }
  }

  async function saveExchange() {
    if (!form.name || !form.apiKey) return alert('Preenche pelo menos o nome e a API Key / Endereço')
    setLoading(true)
    try {
      const id = editing || Date.now().toString()
      await axios.post(`${API}/api/exchanges`, {
        id,
        name: form.name,
        type: form.type,
        apiKey: form.apiKey,
        apiSecret: form.apiSecret || '',
        passphrase: form.passphrase || ''
      })
      await fetchExchanges()
      setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
      setEditing(null)
      onUpdate()
    } catch (e) { alert('Erro ao guardar exchange') }
    finally { setLoading(false) }
  }

  async function removeExchange(id) {
    try {
      await axios.delete(`${API}/api/exchanges/${id}`)
      await fetchExchanges()
      onUpdate()
    } catch (e) { alert('Erro ao remover exchange') }
  }

  function editExchange(ex) {
    setForm({ name: ex.name, type: ex.type, apiKey: '', apiSecret: '', passphrase: '' })
    setEditing(ex.id)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙️ Configurar Exchanges</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-section">
          <h3>{editing ? 'Editar Exchange' : 'Adicionar Exchange'}</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Nome</label>
              <input placeholder="ex: Binance Principal" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Tipo</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value, apiKey: '', apiSecret: '', passphrase: '' })}>
                <option value="binance">Binance</option>
                <option value="bybit">Bybit</option>
                <option value="coinbase">Coinbase</option>
                <option value="kraken">Kraken</option>
                <option value="okx">OKX</option>
                <option value="wallet_eth">Wallet Ethereum</option>
              </select>
            </div>

            {form.type === 'wallet_eth' ? (
              <>
                <div className="form-group full">
                  <label>Endereço Público da Wallet</label>
                  <input placeholder="0x..." value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
                <div className="form-group full">
                  <label>Etherscan API Key <span style={{ color: '#475569', fontWeight: 400 }}>(gratuita em etherscan.io)</span></label>
                  <input placeholder="Cola aqui a tua Etherscan API Key" value={form.apiSecret} onChange={e => setForm({ ...form, apiSecret: e.target.value })} />
                </div>
              </>
            ) : (
              <>
                <div className="form-group full">
                  <label>API Key</label>
                  <input placeholder={editing ? 'Deixa em branco para manter a atual' : 'Cola aqui a tua API Key'} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
                <div className="form-group full">
                  <label>API Secret</label>
                  <input type="password" placeholder={editing ? 'Deixa em branco para manter o atual' : 'Cola aqui o teu API Secret'} value={form.apiSecret} onChange={e => setForm({ ...form, apiSecret: e.target.value })} />
                </div>
                {form.type === 'okx' && (
                  <div className="form-group full">
                    <label>Passphrase <span style={{ color: '#475569', fontWeight: 400 }}>(obrigatório para OKX)</span></label>
                    <input type="password" placeholder="Cola aqui a tua Passphrase" value={form.passphrase || ''} onChange={e => setForm({ ...form, passphrase: e.target.value })} />
                  </div>
                )}
              </>
            )}
          </div>
          <button className="btn-primary" onClick={saveExchange} disabled={loading}>
            {loading ? 'A guardar...' : editing ? 'Guardar Alterações' : '+ Adicionar Exchange'}
          </button>
          {editing && (
            <button className="btn-ghost" onClick={() => { setEditing(null); setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' }) }}>
              Cancelar
            </button>
          )}
        </div>

        {exchanges.length > 0 && (
          <div className="modal-section">
            <h3>Exchanges Configuradas</h3>
            <div className="exchange-list">
              {exchanges.map(ex => (
                <div key={ex.id} className="exchange-item">
                  <div className="exchange-item-info">
                    <span className="exchange-dot" style={{ background: EXCHANGE_TYPES[ex.type]?.color || '#6366f1' }}></span>
                    <div>
                      <strong>{ex.name}</strong>
                      <span>{EXCHANGE_TYPES[ex.type]?.label || ex.type}</span>
                    </div>
                  </div>
                  <div className="exchange-item-actions">
                    <button onClick={() => editExchange(ex)}>Editar</button>
                    <button className="btn-danger" onClick={() => removeExchange(ex.id)}>Remover</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-footer">
          <p className="security-note">🔒 As tuas API keys são guardadas de forma segura na base de dados local do servidor.</p>
          <button className="btn-primary" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────
function Dashboard({ exchange, isGlobal }) {
  const [balances, setBalances] = useState([])
  const [positions, setPositions] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [totalUsdt, setTotalUsdt] = useState(0)
  const [breakdown, setBreakdown] = useState({})
  const [loadingBalances, setLoadingBalances] = useState(true)
  const [loadingPositions, setLoadingPositions] = useState(true)
  const [saving, setSaving] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  const exchangeId = isGlobal ? 'global' : exchange?.id
  const exchangeType = isGlobal ? 'global' : exchange?.type
  const color = EXCHANGE_TYPES[exchangeType]?.color || '#6366f1'

  const accountUrl = isGlobal ? `${API}/api/global/account` : `${API}/api/exchange/${exchangeId}/account`
  const positionsUrl = isGlobal ? `${API}/api/global/positions` : `${API}/api/exchange/${exchangeId}/positions`

  async function fetchBalances() {
    try {
      const res = await axios.get(accountUrl)
      setBalances(res.data.balances || [])
      setTotalUsdt(res.data.totalUsdt || 0)
      setBreakdown(res.data.breakdown || {})
      setLastUpdated(new Date())
    } catch (e) {
      console.error('Erro saldos:', e.message)
    } finally {
      setLoadingBalances(false)
    }
  }

  async function fetchPositions() {
    try {
      const res = await axios.get(positionsUrl)
      setPositions(res.data || [])
    } catch (e) {
      console.error('Erro posições:', e.message)
    } finally {
      setLoadingPositions(false)
    }
  }

  async function fetchSnapshots() {
    try {
      const res = await axios.get(`${API}/api/snapshots/${exchangeId}`)
      setSnapshots(res.data || [])
    } catch (e) { }
  }

  async function saveSnapshot() {
    setSaving(true)
    try {
      await axios.post(`${API}/api/snapshot`, { exchangeId })
      await fetchSnapshots()
    } catch (e) { alert('Erro ao guardar snapshot') }
    finally { setSaving(false) }
  }

  useEffect(() => {
    fetchBalances()
    fetchPositions()
    fetchSnapshots()

    const balancesInterval = setInterval(fetchBalances, 60000)
    const positionsInterval = setInterval(fetchPositions, 5000)

    return () => {
      clearInterval(balancesInterval)
      clearInterval(positionsInterval)
    }
  }, [exchangeId])

  function getPnlForDate(date) {
    const dateStr = dayjs(date).format('YYYY-MM-DD')
    const idx = snapshots.findIndex(s => s.date === dateStr)
    if (idx <= 0) return null
    return snapshots[idx].total_value_usdt - snapshots[idx - 1].total_value_usdt
  }

  function tileContent({ date }) {
    const pnl = getPnlForDate(date)
    if (pnl === null) return null
    const c = pnl >= 0 ? '#22c55e' : '#ef4444'
    return <div style={{ fontSize: '9px', color: c, fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}$</div>
  }

  function tileClassName({ date }) {
    const pnl = getPnlForDate(date)
    if (pnl === null) return null
    return pnl >= 0 ? 'day-profit' : 'day-loss'
  }

  const chartData = snapshots.map(s => ({
    date: dayjs(s.date).format('DD/MM'),
    valor: parseFloat(s.total_value_usdt.toFixed(2))
  }))

  const firstValue = snapshots.length > 0 ? snapshots[0].total_value_usdt : 0
  const totalPnl = totalUsdt - firstValue
  const totalPnlPct = firstValue > 0 ? ((totalPnl / firstValue) * 100).toFixed(2) : 0
  const todayPnl = snapshots.length > 1
    ? snapshots[snapshots.length - 1].total_value_usdt - snapshots[snapshots.length - 2].total_value_usdt
    : 0
  const totalFuturesPnl = positions.reduce((sum, p) => sum + p.pnl, 0)

  return (
    <div>
      <div className="stats">
        <div className="stat-card main" style={{ borderColor: `${color}33` }}>
          <span className="label">Valor Total</span>
          <span className="value">${totalUsdt.toFixed(2)}</span>
          <span className="badge" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalPnl >= 0 ? '▲' : '▼'} {Math.abs(totalPnlPct)}% desde o início
          </span>
        </div>
        <div className="stat-card">
          <span className="label">P&L Histórico</span>
          <span className="value" style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}$
          </span>
          <span className="badge">desde o primeiro snapshot</span>
        </div>
        <div className="stat-card">
          <span className="label">P&L Futuros (aberto)</span>
          <span className="value" style={{ color: totalFuturesPnl >= 0 ? '#22c55e' : '#ef4444' }}>
            {totalFuturesPnl >= 0 ? '+' : ''}{totalFuturesPnl.toFixed(2)}$
          </span>
          <span className="badge">{positions.length} posições • ↻ 5s</span>
        </div>
        {isGlobal ? (
          <div className="stat-card">
            <span className="label">Distribuição</span>
            <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {Object.entries(breakdown).map(([name, value]) => (
                <span key={name} style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                  {name}: <span style={{ color: '#94a3b8' }}>${value.toFixed(2)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="stat-card">
            <span className="label">P&L Hoje</span>
            <span className="value" style={{ color: todayPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {todayPnl >= 0 ? '+' : ''}{todayPnl.toFixed(2)}$
            </span>
            <span className="badge">vs ontem</span>
          </div>
        )}
      </div>

      <div className="main-grid">
        <div className="card">
          <div className="card-header">
            <h2>Evolução da Conta</h2>
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
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }} labelStyle={{ color: '#94a3b8' }} formatter={v => [`$${v}`, 'Valor']} />
              <Area type="monotone" dataKey="valor" stroke={color} strokeWidth={2} fill={`url(#grad-${exchangeId})`} />
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

      <div className="card">
        <div className="card-header">
          <h2>Posições Abertas — Futuros</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {positions.length} posições • ↻ 5s
          </span>
        </div>
        <PositionsTable positions={positions} loading={loadingPositions} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Saldos da Wallet</h2>
          <span className="tag" style={{ color, background: `${color}22` }}>
            {balances.length} ativos • ↻ 60s
          </span>
        </div>
        <BalancesTable balances={balances} totalUsdt={totalUsdt} isGlobal={isGlobal} loading={loadingBalances} />
      </div>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────
export default function App() {
  const [exchanges, setExchanges] = useState([])
  const [activeTab, setActiveTab] = useState('global')
  const [showSettings, setShowSettings] = useState(false)

  async function fetchExchanges() {
    try {
      const res = await axios.get(`${API}/api/exchanges`)
      setExchanges(res.data)
      if (res.data.length === 0) setShowSettings(true)
    } catch (e) { console.error(e) }
  }

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
        <button className="btn-settings" onClick={() => setShowSettings(true)}>⚙️ Configurações</button>
      </header>

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
        <Dashboard key={activeTab} exchange={activeExchange} isGlobal={isGlobal} />
      ) : (
        <div className="empty-dashboard">
          <p>Nenhuma exchange configurada.</p>
          <button className="btn-primary" onClick={() => setShowSettings(true)}>Configurar agora</button>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onUpdate={fetchExchanges}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}