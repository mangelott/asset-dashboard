import { useState, useEffect } from 'react'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import dayjs from 'dayjs'
import { API } from '../constants'
import { useCurrency } from '../context/CurrencyContext'
import AppNav from '../components/AppNav'
import StrategySpecSummary from '../components/StrategySpecSummary'

const STATUS_LABELS = {
  draft: { label: 'Rascunho', color: '#94a3b8' },
  backtesting: { label: 'Em afinação', color: '#f59e0b' },
  live: { label: 'Ao vivo', color: '#22c55e' },
  paused: { label: 'Pausada', color: '#ef4444' }
}

function StrategyList({ strategies, onSelect, onCreate }) {
  const { formatMoney } = useCurrency()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try { await onCreate(name.trim()); setName('') }
    finally { setCreating(false) }
  }

  return (
    <div>
      <div className="card">
        <div className="card-header"><h2>Nova Estratégia</h2></div>
        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px' }}>
          <input placeholder="ex: RSI Dip Buyer" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn-primary" type="submit" disabled={creating}>{creating ? '...' : '+ Criar'}</button>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>As Tuas Estratégias</h2>
          <span className="tag" style={{ color: '#6366f1', background: '#6366f122' }}>{strategies.length}</span>
        </div>
        {!strategies.length ? (
          <div className="empty-state">Ainda não tens estratégias — cria a primeira acima</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {strategies.map(s => {
              const status = STATUS_LABELS[s.status] || STATUS_LABELS.draft
              return (
                <div key={s.id} onClick={() => onSelect(s.id)}
                  className="exchange-item" style={{ cursor: 'pointer' }}>
                  <div className="exchange-item-info">
                    <span className="exchange-dot" style={{ background: status.color }}></span>
                    <div>
                      <strong>{s.name}</strong>
                      <span>{status.label} · Equity: {formatMoney(parseFloat(s.equity))}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ChatPanel({ strategy, onSpecApplied }) {
  const [messages, setMessages] = useState(strategy.messages || [])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [proposedSpec, setProposedSpec] = useState(null)
  const [applying, setApplying] = useState(false)

  async function sendMessage(e) {
    e.preventDefault()
    if (!input.trim()) return
    const userMsg = input.trim()
    setInput('')
    setMessages(m => [...m, { role: 'user', content: userMsg }])
    setLoading(true)
    try {
      const res = await axios.post(`${API}/api/paper/strategies/${strategy.id}/chat`, { message: userMsg })
      setMessages(m => [...m, { role: 'assistant', content: res.data.reply }])
      if (res.data.proposedSpec) setProposedSpec(res.data.proposedSpec)
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: `⚠️ ${e.response?.data?.error || 'Erro ao contactar o assistente'}` }])
    } finally {
      setLoading(false)
    }
  }

  async function applySpec() {
    setApplying(true)
    try {
      const { assets, timeframe, ...spec } = proposedSpec
      await axios.post(`${API}/api/paper/strategies/${strategy.id}/apply-spec`, { assets, timeframe, ...spec })
      setProposedSpec(null)
      onSpecApplied()
    } catch (e) {
      alert(e.response?.data?.error || 'Erro ao aplicar a estratégia')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2>Conversa</h2></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '360px', overflowY: 'auto', marginBottom: '12px' }}>
        {!messages.length && (
          <div className="empty-state">Descreve a tua ideia de estratégia em texto livre. Ex: "Quero comprar BTC quando o RSI de 14 períodos cair abaixo de 30, com stop de 3% e take-profit de 6%."</div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            background: m.role === 'user' ? '#6366f122' : '#0c0c10',
            border: '1px solid #18181f',
            borderRadius: '10px',
            padding: '10px 14px',
            fontSize: '13px',
            whiteSpace: 'pre-wrap'
          }}>
            {m.content}
          </div>
        ))}
        {loading && <div className="table-loading">A pensar...</div>}
      </div>

      {proposedSpec && (
        <div style={{ background: '#0c0c10', border: '1px solid #6366f1', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px', color: '#6366f1' }}>Proposta de estratégia</strong>
          <StrategySpecSummary assets={proposedSpec.assets} timeframe={proposedSpec.timeframe} spec={proposedSpec} />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button className="btn-primary" onClick={applySpec} disabled={applying}>{applying ? '...' : 'Aplicar'}</button>
            <button className="btn-ghost" onClick={() => setProposedSpec(null)}>Descartar</button>
          </div>
        </div>
      )}

      <form onSubmit={sendMessage} style={{ display: 'flex', gap: '8px' }}>
        <input placeholder="Escreve a tua mensagem..." value={input} onChange={e => setInput(e.target.value)} style={{ flex: 1 }} disabled={loading} />
        <button className="btn-primary" type="submit" disabled={loading}>Enviar</button>
      </form>
    </div>
  )
}

function BacktestPanel({ strategy, onBacktestRun }) {
  const { formatMoney } = useCurrency()
  const [running, setRunning] = useState(false)
  const [days, setDays] = useState(365)
  const latestRaw = strategy.backtests?.[0]
  const latest = latestRaw ? {
    ...latestRaw,
    metrics: typeof latestRaw.metrics === 'string' ? JSON.parse(latestRaw.metrics) : latestRaw.metrics,
    equity_curve: typeof latestRaw.equity_curve === 'string' ? JSON.parse(latestRaw.equity_curve) : latestRaw.equity_curve
  } : null
  const assetsList = typeof strategy.assets === 'string' ? JSON.parse(strategy.assets) : strategy.assets
  const hasSpec = assetsList?.length > 0 && strategy.timeframe

  async function runBacktest() {
    setRunning(true)
    try {
      await axios.post(`${API}/api/paper/strategies/${strategy.id}/backtest`, { days })
      onBacktestRun()
    } catch (e) {
      alert(e.response?.data?.error || 'Erro ao correr o backtest')
    } finally {
      setRunning(false)
    }
  }

  const chartData = (latest?.equity_curve || []).map(p => ({
    date: dayjs(p.time).format('DD/MM'),
    equity: p.equity
  }))

  return (
    <div className="card">
      <div className="card-header">
        <h2>Backtest</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select value={days} onChange={e => setDays(parseInt(e.target.value))}>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
            <option value={180}>180 dias</option>
            <option value={365}>1 ano</option>
          </select>
          <button className="btn-primary" onClick={runBacktest} disabled={running || !hasSpec}>
            {running ? 'A correr...' : 'Correr Backtest'}
          </button>
        </div>
      </div>

      {!hasSpec && <div className="empty-state">Define a estratégia na conversa antes de correr um backtest</div>}

      {latest && (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="grad-backtest" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 12 }} />
              <YAxis stroke="#475569" tick={{ fontSize: 12 }} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }} formatter={v => [formatMoney(v), 'Equity']} />
              <Area type="monotone" dataKey="equity" stroke="#6366f1" strokeWidth={2} fill="url(#grad-backtest)" />
            </AreaChart>
          </ResponsiveContainer>

          <div className="stats" style={{ marginTop: '16px' }}>
            {(latest.metrics.perAsset || []).map(m => (
              <div className="stat-card" key={m.symbol}>
                <span className="label">{m.symbol}</span>
                <span className="value" style={{ color: m.totalPnl >= 0 ? '#22c55e' : '#ef4444', fontSize: '20px' }}>
                  {m.totalPnl >= 0 ? '+' : ''}{formatMoney(m.totalPnl)}
                </span>
                <span className="badge">{m.totalTrades} trades · {m.winRate.toFixed(0)}% win rate</span>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px' }}>
                  Profit factor: {m.profitFactor.toFixed(2)} · Max drawdown: {m.maxDrawdownPct.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function LivePanel({ strategy }) {
  const { formatMoney } = useCurrency()
  const [positions, setPositions] = useState([])
  const [equitySnapshots, setEquitySnapshots] = useState([])

  async function fetchLiveData() {
    try {
      const [posRes, eqRes] = await Promise.all([
        axios.get(`${API}/api/paper/strategies/${strategy.id}/positions`),
        axios.get(`${API}/api/paper/strategies/${strategy.id}/equity`)
      ])
      setPositions(posRes.data || [])
      setEquitySnapshots(eqRes.data || [])
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount + polling
    fetchLiveData()
    const interval = setInterval(fetchLiveData, 60000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchLiveData is stable for a given strategy.id
  }, [strategy.id])

  const open = positions.filter(p => p.status === 'open')
  const closed = positions.filter(p => p.status === 'closed')
  const equityChartData = equitySnapshots.map(s => ({
    date: dayjs(s.recorded_at).format('DD/MM HH:mm'),
    equity: parseFloat(s.equity_usd)
  }))

  return (
    <div className="card">
      <div className="card-header">
        <h2>Paper Trading — Ao Vivo</h2>
        <span className="tag" style={{ color: '#22c55e', background: '#22c55e22' }}>Equity: {formatMoney(parseFloat(strategy.equity))}</span>
      </div>

      {equityChartData.length > 1 && (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={equityChartData}>
            <defs>
              <linearGradient id="grad-live-equity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 11 }} />
            <YAxis stroke="#475569" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }} formatter={v => [formatMoney(v), 'Equity']} />
            <Area type="monotone" dataKey="equity" stroke="#22c55e" strokeWidth={2} fill="url(#grad-live-equity)" />
          </AreaChart>
        </ResponsiveContainer>
      )}

      <div className="table-section-label">Posições Abertas ({open.length})</div>
      {!open.length ? <div className="empty-state">Nenhuma posição aberta</div> : (
        <table>
          <thead><tr><th>Ativo</th><th>Direção</th><th>Entrada</th><th>Quantidade</th><th>Alavancagem</th><th>Aberta em</th></tr></thead>
          <tbody>
            {open.map(p => (
              <tr key={p.id}>
                <td>{p.asset}</td>
                <td style={{ color: p.side === 'long' ? '#22c55e' : '#ef4444' }}>{p.side === 'long' ? '▲ Long' : '▼ Short'}</td>
                <td>{formatMoney(parseFloat(p.entry_price), 4)}</td>
                <td>{parseFloat(p.qty).toFixed(6)}</td>
                <td>{p.leverage}x</td>
                <td style={{ fontSize: '12px', color: '#94a3b8' }}>{dayjs(p.opened_at).format('DD MMM HH:mm')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="table-section-label" style={{ marginTop: '16px' }}>Histórico ({closed.length})</div>
      {!closed.length ? <div className="empty-state">Ainda sem operações fechadas</div> : (
        <table>
          <thead><tr><th>Ativo</th><th>Direção</th><th>Entrada</th><th>Saída</th><th>P&L</th><th>Fechada em</th></tr></thead>
          <tbody>
            {closed.map(p => (
              <tr key={p.id}>
                <td>{p.asset}</td>
                <td>{p.side === 'long' ? 'Long' : 'Short'}</td>
                <td>{formatMoney(parseFloat(p.entry_price), 4)}</td>
                <td>{formatMoney(parseFloat(p.exit_price), 4)}</td>
                <td style={{ color: p.pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                  {p.pnl >= 0 ? '+' : ''}{formatMoney(parseFloat(p.pnl))}
                </td>
                <td style={{ fontSize: '12px', color: '#94a3b8' }}>{dayjs(p.closed_at).format('DD MMM HH:mm')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function StrategyDetail({ strategyId, onBack }) {
  const [strategy, setStrategy] = useState(null)
  const [loading, setLoading] = useState(true)

  async function fetchDetail() {
    try {
      const res = await axios.get(`${API}/api/paper/strategies/${strategyId}`)
      setStrategy(res.data)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount
    fetchDetail()
  }, [strategyId])

  async function activate() {
    try {
      await axios.post(`${API}/api/paper/strategies/${strategyId}/activate`)
      fetchDetail()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao ativar') }
  }

  async function pause() {
    try {
      await axios.post(`${API}/api/paper/strategies/${strategyId}/pause`)
      fetchDetail()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao pausar') }
  }

  if (loading || !strategy) return <div className="table-loading">A carregar...</div>

  const status = STATUS_LABELS[strategy.status] || STATUS_LABELS.draft
  const assets = typeof strategy.assets === 'string' ? JSON.parse(strategy.assets) : strategy.assets
  const spec = typeof strategy.spec === 'string' ? JSON.parse(strategy.spec) : strategy.spec

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <button className="btn-ghost" onClick={onBack}>← Voltar</button>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className="tag" style={{ color: status.color, background: `${status.color}22` }}>{status.label}</span>
          {strategy.status !== 'live' && (
            <button className="btn-primary" onClick={activate} disabled={!strategy.backtests?.length}>Ativar (Paper Trading)</button>
          )}
          {strategy.status === 'live' && <button className="btn-danger" onClick={pause}>Pausar</button>}
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h2>{strategy.name}</h2></div>
        {assets?.length > 0 ? (
          <StrategySpecSummary assets={assets} timeframe={strategy.timeframe} spec={spec} />
        ) : (
          <div className="empty-state">Ainda sem estratégia definida — usa a conversa abaixo</div>
        )}
      </div>

      {strategy.status === 'live' && <LivePanel strategy={strategy} />}

      <div className="main-grid">
        <ChatPanel strategy={strategy} onSpecApplied={fetchDetail} />
        <BacktestPanel strategy={strategy} onBacktestRun={fetchDetail} />
      </div>
    </div>
  )
}

export default function PaperTrading() {
  const [strategies, setStrategies] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)

  async function fetchStrategies() {
    try {
      const res = await axios.get(`${API}/api/paper/strategies`)
      setStrategies(res.data || [])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount
    fetchStrategies()
  }, [])

  async function createStrategy(name) {
    const res = await axios.post(`${API}/api/paper/strategies`, { name })
    await fetchStrategies()
    setSelectedId(res.data.id)
  }

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo" style={{ background: 'linear-gradient(135deg, #6366f1, #6366f199)' }}>📊</div>
          <div>
            <h1>Paper Trading</h1>
            <span className="subtitle">Estratégias simuladas com IA — sem dinheiro real</span>
          </div>
        </div>
      </header>

      <AppNav />

      {loading ? (
        <div className="table-loading">A carregar...</div>
      ) : selectedId ? (
        <StrategyDetail strategyId={selectedId} onBack={() => { setSelectedId(null); fetchStrategies() }} />
      ) : (
        <StrategyList strategies={strategies} onSelect={setSelectedId} onCreate={createStrategy} />
      )}
    </div>
  )
}
