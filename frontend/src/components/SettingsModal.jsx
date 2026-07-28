import { useState, useEffect } from 'react'
import axios from 'axios'
import dayjs from 'dayjs'
import { API, EXCHANGE_TYPES } from '../constants'

const DEPOSIT_AUTO = { kraken: 'auto', bybit: 'auto-fallback' }

export default function SettingsModal({ onClose, onUpdate }) {
  const [exchanges, setExchanges] = useState([])
  const [form, setForm] = useState({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [shareToken, setShareToken] = useState(null)
  const [shareShowValues, setShareShowValues] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [initialCapital, setInitialCapital] = useState('')
  const [deposits, setDeposits] = useState([])
  const [depositForm, setDepositForm] = useState({ amount: '', date: '', note: '' })
  const [loadingDeposit, setLoadingDeposit] = useState(false)

  useEffect(() => { fetchExchanges(); fetchShareLink() }, [])

  async function fetchExchanges() {
    try {
      const res = await axios.get(`${API}/api/exchanges`)
      setExchanges(res.data)
    } catch (e) { console.error(e) }
  }

  async function fetchShareLink() {
    try {
      const res = await axios.get(`${API}/api/share/me`)
      if (res.data) {
        setShareToken(res.data.token)
        setShareShowValues(res.data.showValues)
      }
    } catch (e) { console.error(e) }
  }

  async function generateShareLink() {
    setShareLoading(true)
    try {
      const res = await axios.post(`${API}/api/share`, { showValues: shareShowValues })
      setShareToken(res.data.token)
    } catch (e) { alert(e.response?.data?.error || 'Error generating link') }
    finally { setShareLoading(false) }
  }

  async function revokeShareLink() {
    setShareLoading(true)
    try {
      await axios.delete(`${API}/api/share`)
      setShareToken(null)
    } catch (e) { alert(e.response?.data?.error || 'Error revoking link') }
    finally { setShareLoading(false) }
  }

  function copyShareLink() {
    navigator.clipboard.writeText(`${window.location.origin}/share/${shareToken}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function fetchDeposits(exchangeId) {
    try {
      const res = await axios.get(`${API}/api/exchanges/${exchangeId}/deposits`)
      setDeposits(res.data || [])
    } catch (e) { console.error(e) }
  }

  async function addDeposit() {
    const amount = parseFloat(depositForm.amount)
    if (!amount || amount <= 0) return alert('Enter a valid amount')
    setLoadingDeposit(true)
    try {
      await axios.post(`${API}/api/exchanges/${editing}/deposits`, depositForm)
      await fetchDeposits(editing)
      setDepositForm({ amount: '', date: '', note: '' })
    } catch (e) { alert(e.response?.data?.error || 'Error adding deposit') }
    finally { setLoadingDeposit(false) }
  }

  async function removeDeposit(depositId) {
    try {
      await axios.delete(`${API}/api/deposits/${depositId}`)
      await fetchDeposits(editing)
    } catch (e) { alert(e.response?.data?.error || 'Error removing deposit') }
  }

  async function saveExchange() {
    if (!form.name || !form.apiKey) return alert('Please fill in at least the name and API Key / Address')
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
      if (!editing && initialCapital && parseFloat(initialCapital) > 0) {
        await axios.post(`${API}/api/exchanges/${id}/deposits`, {
          amount: parseFloat(initialCapital),
          date: new Date().toISOString().split('T')[0],
          note: 'Capital inicial'
        })
      }
      await fetchExchanges()
      setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
      setInitialCapital('')
      setEditing(null)
      setDeposits([])
      onUpdate()
    } catch (e) { alert(e.response?.data?.error || 'Error saving exchange') }
    finally { setLoading(false) }
  }

  async function removeExchange(id) {
    try {
      await axios.delete(`${API}/api/exchanges/${id}`)
      await fetchExchanges()
      onUpdate()
    } catch (e) { alert(e.response?.data?.error || 'Error removing exchange') }
  }

  function editExchange(ex) {
    setForm({ name: ex.name, type: ex.type, apiKey: '', apiSecret: '', passphrase: '' })
    setEditing(ex.id)
    fetchDeposits(ex.id)
  }

  function cancelEdit() {
    setEditing(null)
    setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
    setInitialCapital('')
    setDeposits([])
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙️ Configure Exchanges</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-section">
          <h3>{editing ? 'Edit Exchange' : 'Add Exchange'}</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Name</label>
              <input placeholder="e.g.: Main Binance" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value, apiKey: '', apiSecret: '', passphrase: '' })}>
                <option value="binance">Binance</option>
                <option value="bybit">Bybit</option>
                <option value="coinbase">Coinbase</option>
                <option value="kraken">Kraken</option>
                <option value="okx">OKX</option>
                <option value="wallet_eth">Ethereum Wallet</option>
                <option value="trading212">Trading 212</option>
              </select>
            </div>

            {form.type === 'wallet_eth' ? (
              <>
                <div className="form-group full">
                  <label>Public Wallet Address</label>
                  <input placeholder="0x..." value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
                <div className="form-group full">
                  <label>Etherscan API Key <span style={{ color: '#475569', fontWeight: 400 }}>(free at etherscan.io)</span></label>
                  <input placeholder="Paste your Etherscan API Key here" value={form.apiSecret} onChange={e => setForm({ ...form, apiSecret: e.target.value })} />
                </div>
              </>
            ) : form.type === 'trading212' ? (
              <>
                <div className="form-group full">
                  <label>API Key <span style={{ color: '#475569', fontWeight: 400 }}>(Settings → API in the Trading 212 app)</span></label>
                  <input placeholder={editing ? 'Leave blank to keep current' : 'Paste your Trading 212 API Key here'} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
                <div className="form-group full">
                  <label>API Secret <span style={{ color: '#475569', fontWeight: 400 }}>(Settings → API in the Trading 212 app)</span></label>
                  <input type="password" placeholder={editing ? 'Leave blank to keep current' : 'Paste your Trading 212 API Secret here'} value={form.apiSecret} onChange={e => setForm({ ...form, apiSecret: e.target.value })} />
                </div>
              </>
            ) : (
              <>
                <div className="form-group full">
                  <label>API Key</label>
                  <input placeholder={editing ? 'Leave blank to keep current' : 'Paste your API Key here'} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
                <div className="form-group full">
                  <label>API Secret</label>
                  <input type="password" placeholder={editing ? 'Leave blank to keep current' : 'Paste your API Secret here'} value={form.apiSecret} onChange={e => setForm({ ...form, apiSecret: e.target.value })} />
                </div>
                {form.type === 'okx' && (
                  <div className="form-group full">
                    <label>Passphrase <span style={{ color: '#475569', fontWeight: 400 }}>(required for OKX)</span></label>
                    <input type="password" placeholder="Paste your Passphrase here" value={form.passphrase || ''} onChange={e => setForm({ ...form, passphrase: e.target.value })} />
                  </div>
                )}
              </>
            )}
          </div>
          {!editing && (
            <div className="form-group full">
              <label>Capital Inicial (USD) <span style={{ color: '#475569', fontWeight: 400 }}>(opcional — total depositado até hoje)</span></label>
              <input type="number" min="0" step="0.01" placeholder="Ex: 5000" value={initialCapital} onChange={e => setInitialCapital(e.target.value)} />
            </div>
          )}
          <button className="btn-primary" onClick={saveExchange} disabled={loading}>
            {loading ? 'Saving...' : editing ? 'Save Changes' : '+ Add Exchange'}
          </button>
          {editing && (
            <button className="btn-ghost" onClick={cancelEdit}>Cancel</button>
          )}
        </div>

        {editing && (() => {
          const editingExchange = exchanges.find(e => e.id === editing)
          const depositAutoMode = editingExchange ? DEPOSIT_AUTO[editingExchange.type] : null
          const depositsTotal = deposits.reduce((s, d) => s + parseFloat(d.amount_usd), 0)
          return (
            <div className="modal-section deposits-section">
              <h4>Depósitos Manuais</h4>
              {depositAutoMode === 'auto' && (
                <p className="deposit-hint">✓ Esta exchange obtém depósitos automaticamente via API. Podes adicionar entradas manuais como complemento se necessário.</p>
              )}
              {depositAutoMode === 'auto-fallback' && (
                <p className="deposit-hint">⚡ Esta exchange tenta obter depósitos via API (requer permissão "Asset" na API key). Adiciona manualmente se não tiver essa permissão.</p>
              )}
              {!depositAutoMode && (
                <p className="deposit-hint">Regista aqui os valores que depositaste nesta conta para que o P&L histórico seja calculado correctamente.</p>
              )}
              {deposits.length > 0 && (
                <div className="deposits-list">
                  {deposits.map(d => (
                    <div key={d.id} className="deposit-item">
                      <span className="deposit-date">{dayjs(d.deposit_date).format('DD/MM/YYYY')}</span>
                      <span className="deposit-amount">${parseFloat(d.amount_usd).toFixed(2)}</span>
                      {d.note && <span className="deposit-note">{d.note}</span>}
                      <button className="deposit-remove" onClick={() => removeDeposit(d.id)}>✕</button>
                    </div>
                  ))}
                  <div className="deposits-total">Total manual: <strong>${depositsTotal.toFixed(2)}</strong></div>
                </div>
              )}
              <div className="deposit-add-form">
                <input type="number" min="0" step="0.01" placeholder="Valor (USD)" value={depositForm.amount}
                  onChange={e => setDepositForm({ ...depositForm, amount: e.target.value })} />
                <input type="date" value={depositForm.date}
                  onChange={e => setDepositForm({ ...depositForm, date: e.target.value })} />
                <input placeholder="Nota (opcional)" value={depositForm.note}
                  onChange={e => setDepositForm({ ...depositForm, note: e.target.value })} />
                <button className="btn-primary" onClick={addDeposit} disabled={loadingDeposit}>
                  {loadingDeposit ? '...' : '+ Adicionar Depósito'}
                </button>
              </div>
            </div>
          )
        })()}

        {exchanges.length > 0 && (
          <div className="modal-section">
            <h3>Configured Exchanges</h3>
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
                    <button onClick={() => editExchange(ex)}>Edit</button>
                    <button className="btn-danger" onClick={() => removeExchange(ex.id)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-section">
          <h3>🔗 Public Share Link</h3>
          <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '12px' }}>
            Share a read-only view of your Global portfolio — no login required to view.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginBottom: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={shareShowValues} onChange={e => setShareShowValues(e.target.checked)} />
            Show real values (otherwise viewers only see percentages)
          </label>

          {shareToken && (
            <div className="form-group full">
              <input readOnly value={`${window.location.origin}/share/${shareToken}`} onClick={e => e.target.select()} />
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-primary" onClick={generateShareLink} disabled={shareLoading}>
              {shareLoading ? '...' : shareToken ? 'Regenerate Link' : 'Generate Share Link'}
            </button>
            {shareToken && (
              <>
                <button className="btn-ghost" onClick={copyShareLink}>{copied ? 'Copied!' : 'Copy Link'}</button>
                <button className="btn-danger" onClick={revokeShareLink} disabled={shareLoading}>Revoke</button>
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <p className="security-note">🔒 Your API keys are stored securely in the server's local database.</p>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
