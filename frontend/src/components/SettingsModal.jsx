import { useState, useEffect } from 'react'
import axios from 'axios'
import { API, EXCHANGE_TYPES } from '../constants'

export default function SettingsModal({ onClose, onUpdate }) {
  const [exchanges, setExchanges] = useState([])
  const [form, setForm] = useState({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [shareToken, setShareToken] = useState(null)
  const [shareShowValues, setShareShowValues] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [copied, setCopied] = useState(false)

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
      await fetchExchanges()
      setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' })
      setEditing(null)
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
          <button className="btn-primary" onClick={saveExchange} disabled={loading}>
            {loading ? 'Saving...' : editing ? 'Save Changes' : '+ Add Exchange'}
          </button>
          {editing && (
            <button className="btn-ghost" onClick={() => { setEditing(null); setForm({ name: '', type: 'binance', apiKey: '', apiSecret: '', passphrase: '' }) }}>
              Cancel
            </button>
          )}
        </div>

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
