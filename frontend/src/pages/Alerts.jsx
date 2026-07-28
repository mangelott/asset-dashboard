import { useState, useEffect } from 'react'
import axios from 'axios'
import { API } from '../constants'
import AppNav from '../components/AppNav'

const CONDITIONS = [
  { value: 'candle_close_above', label: 'Vela fecha acima de', needsTimeframe: true },
  { value: 'candle_close_below', label: 'Vela fecha abaixo de', needsTimeframe: true },
  { value: 'price_above', label: 'Preço sobe acima de', needsTimeframe: false },
  { value: 'price_below', label: 'Preço desce abaixo de', needsTimeframe: false }
]

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

export default function Alerts() {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [telegramStatus, setTelegramStatus] = useState(null)
  const [inviteUrl, setInviteUrl] = useState(null)
  const [form, setForm] = useState({ asset: '', condition: 'candle_close_above', timeframe: '15m', threshold: '', isRecurring: false })
  const [saving, setSaving] = useState(false)

  async function fetchAlerts() {
    try {
      const res = await axios.get(`${API}/api/alerts`)
      setAlerts(res.data || [])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  async function fetchTelegramStatus() {
    try {
      const res = await axios.get(`${API}/api/telegram/status`)
      setTelegramStatus(res.data)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount
    fetchAlerts()
    fetchTelegramStatus()
  }, [])

  async function connectTelegram() {
    try {
      const res = await axios.post(`${API}/api/telegram/link`)
      setInviteUrl(res.data.url)
    } catch (e) { alert(e.response?.data?.error || 'Erro ao gerar link do Telegram') }
  }

  async function disconnectTelegram() {
    try {
      await axios.delete(`${API}/api/telegram/link`)
      setInviteUrl(null)
      fetchTelegramStatus()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao desligar Telegram') }
  }

  async function createAlert(e) {
    e.preventDefault()
    if (!form.asset || !form.threshold) return alert('Preenche o ativo e o valor')
    setSaving(true)
    try {
      await axios.post(`${API}/api/alerts`, {
        asset: form.asset.toUpperCase(),
        condition: form.condition,
        timeframe: CONDITIONS.find(c => c.value === form.condition)?.needsTimeframe ? form.timeframe : null,
        threshold: parseFloat(form.threshold),
        isRecurring: form.isRecurring
      })
      setForm({ asset: '', condition: 'candle_close_above', timeframe: '15m', threshold: '', isRecurring: false })
      fetchAlerts()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao criar alerta') }
    finally { setSaving(false) }
  }

  async function removeAlert(id) {
    try {
      await axios.delete(`${API}/api/alerts/${id}`)
      fetchAlerts()
    } catch (e) { alert(e.response?.data?.error || 'Erro ao remover alerta') }
  }

  const selectedCondition = CONDITIONS.find(c => c.value === form.condition)

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo" style={{ background: 'linear-gradient(135deg, #6366f1, #6366f199)' }}>🔔</div>
          <div>
            <h1>Alertas</h1>
            <span className="subtitle">Notificações de preço via Telegram</span>
          </div>
        </div>
      </header>

      <AppNav />

      <div className="card">
        <div className="card-header">
          <h2>Telegram</h2>
        </div>
        {telegramStatus?.configured === false ? (
          <div className="empty-state">Bot do Telegram ainda não configurado no servidor.</div>
        ) : telegramStatus?.linked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ color: '#22c55e', fontWeight: 600 }}>✓ Ligado</span>
            <button className="btn-danger" onClick={disconnectTelegram}>Desligar</button>
          </div>
        ) : (
          <div>
            {inviteUrl ? (
              <div>
                <p style={{ marginBottom: '12px' }}>Abre este link no telemóvel para ligar o Telegram (válido 10 minutos):</p>
                <a href={inviteUrl} target="_blank" rel="noreferrer" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-block' }}>
                  Abrir no Telegram
                </a>
              </div>
            ) : (
              <button className="btn-primary" onClick={connectTelegram}>Ligar ao Telegram</button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Novo Alerta</h2>
        </div>
        <form onSubmit={createAlert} className="form-grid">
          <div className="form-group">
            <label>Ativo</label>
            <input placeholder="ex: BTC" value={form.asset} onChange={e => setForm({ ...form, asset: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Condição</label>
            <select value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })}>
              {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          {selectedCondition?.needsTimeframe && (
            <div className="form-group">
              <label>Timeframe</label>
              <select value={form.timeframe} onChange={e => setForm({ ...form, timeframe: e.target.value })}>
                {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Valor ($)</label>
            <input type="number" step="any" placeholder="ex: 62500" value={form.threshold} onChange={e => setForm({ ...form, threshold: e.target.value })} />
          </div>
          <div className="form-group" style={{ justifyContent: 'flex-end' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.isRecurring} onChange={e => setForm({ ...form, isRecurring: e.target.checked })} />
              Repetir sempre que a condição se verificar
            </label>
          </div>
        </form>
        <button className="btn-primary" onClick={createAlert} disabled={saving}>
          {saving ? 'A criar...' : '+ Criar Alerta'}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Alertas Ativos</h2>
          <span className="tag" style={{ color: '#6366f1', background: '#6366f122' }}>{alerts.length} alertas</span>
        </div>
        {loading ? (
          <div className="table-loading">A carregar...</div>
        ) : !alerts.length ? (
          <div className="empty-state">Ainda não tens alertas configurados</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th>Condição</th>
                <th>Timeframe</th>
                <th>Valor</th>
                <th>Estado</th>
                <th>Último Disparo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id}>
                  <td><span className="asset-badge" style={{ color: '#6366f1', background: '#6366f122' }}>{a.asset}</span></td>
                  <td>{CONDITIONS.find(c => c.value === a.condition)?.label || a.condition}</td>
                  <td>{a.timeframe || '—'}</td>
                  <td>${a.threshold}</td>
                  <td>
                    {a.active
                      ? <span className="tag" style={{ color: '#22c55e', background: '#22c55e22' }}>{a.is_recurring ? 'Ativo (recorrente)' : 'Ativo (única vez)'}</span>
                      : <span className="tag" style={{ color: '#94a3b8', background: '#94a3b822' }}>Disparado</span>}
                  </td>
                  <td style={{ fontSize: '12px', color: '#94a3b8' }}>{a.last_triggered_at ? new Date(a.last_triggered_at).toLocaleString() : 'Nunca'}</td>
                  <td><button className="btn-danger" onClick={() => removeAlert(a.id)}>Remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
