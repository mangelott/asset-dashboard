import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { usePlan } from '../context/PlanContext'

const PRICE_MONTHLY = import.meta.env.VITE_STRIPE_PRICE_MONTHLY || ''
const PRICE_ANNUAL = import.meta.env.VITE_STRIPE_PRICE_ANNUAL || ''

const PRO_FEATURES = [
  { icon: '🔔', label: 'Alertas de Preço', desc: 'Notificações push e Telegram em tempo real' },
  { icon: '📊', label: 'P&L Realizado', desc: 'Histórico de lucros e perdas detalhado' },
  { icon: '⚡', label: 'Snapshots Intraday', desc: 'Evolução horária do portfólio' },
  { icon: '📈', label: 'Benchmark BTC/ETH', desc: 'Compara a tua performance com o mercado' },
  { icon: '🤖', label: 'Paper Trading', desc: 'Testa estratégias sem arriscar capital real' },
  { icon: '📱', label: 'Notificações Push', desc: 'Alertas direto no browser e telemóvel' },
]

export default function Upgrade() {
  const { isPro, planData, refresh } = usePlan()
  const navigate = useNavigate()
  const [annual, setAnnual] = useState(false)
  const [loading, setLoading] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleCheckout() {
    const priceId = annual ? PRICE_ANNUAL : PRICE_MONTHLY
    if (!priceId) {
      setError('Stripe ainda não está configurado. Volta em breve!')
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data } = await axios.post('/api/billing/checkout', { priceId })
      window.location.href = data.url
    } catch (e) {
      setError(e.response?.data?.error || 'Erro ao criar sessão de pagamento')
      setLoading(false)
    }
  }

  async function handlePortal() {
    setPortalLoading(true)
    setError('')
    try {
      const { data } = await axios.post('/api/billing/portal')
      window.location.href = data.url
    } catch (e) {
      setError(e.response?.data?.error || 'Erro ao abrir portal de faturação')
      setPortalLoading(false)
    }
  }

  return (
    <div className="upgrade-page">
      <div className="upgrade-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Voltar</button>
        <h1 className="upgrade-title">Asset Dashboard <span className="pro-badge">PRO</span></h1>
        <p className="upgrade-subtitle">Desbloqueia todas as funcionalidades avançadas</p>
      </div>

      {isPro ? (
        <div className="upgrade-current-plan">
          <div className="current-plan-card">
            <div className="current-plan-icon">✅</div>
            <div>
              <h2>Estás no plano Pro</h2>
              {planData?.current_period_end && (
                <p style={{ color: '#94a3b8', fontSize: '14px', marginTop: '4px' }}>
                  {planData.cancel_at_period_end
                    ? `Cancela em ${new Date(planData.current_period_end).toLocaleDateString('pt-PT')}`
                    : `Renova em ${new Date(planData.current_period_end).toLocaleDateString('pt-PT')}`}
                </p>
              )}
            </div>
            <button className="btn-portal" onClick={handlePortal} disabled={portalLoading}>
              {portalLoading ? 'A abrir...' : 'Gerir Subscrição'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="upgrade-toggle">
            <span className={!annual ? 'toggle-active' : ''} onClick={() => setAnnual(false)}>Mensal</span>
            <div className={`toggle-switch ${annual ? 'on' : ''}`} onClick={() => setAnnual(v => !v)}>
              <div className="toggle-thumb" />
            </div>
            <span className={annual ? 'toggle-active' : ''} onClick={() => setAnnual(true)}>
              Anual <span className="save-badge">Poupa 30%</span>
            </span>
          </div>

          <div className="upgrade-price">
            <span className="price-amount">{annual ? '€1.74' : '€2.49'}</span>
            <span className="price-period">/ mês</span>
            {annual && <div className="price-annual">Faturado anualmente — €20.88/ano</div>}
          </div>
        </>
      )}

      <div className="upgrade-features">
        {PRO_FEATURES.map(f => (
          <div key={f.label} className="feature-row">
            <span className="feature-icon">{f.icon}</span>
            <div>
              <div className="feature-label">{f.label}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
            <span className="feature-check">✓</span>
          </div>
        ))}
      </div>

      {!isPro && (
        <>
          {error && <div className="upgrade-error">{error}</div>}
          <button className="btn-upgrade-cta" onClick={handleCheckout} disabled={loading}>
            {loading ? 'A redirecionar...' : `Subscrever Pro — ${annual ? '€20.88/ano' : '€2.49/mês'}`}
          </button>
          <p className="upgrade-fine-print">Cancela quando quiseres. Sem compromisso.</p>
        </>
      )}
    </div>
  )
}
