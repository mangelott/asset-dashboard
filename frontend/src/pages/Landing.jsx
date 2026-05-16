import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const EXCHANGES = ['Binance', 'Bybit', 'Coinbase', 'Kraken', 'OKX', 'ETH Wallet']

const FEATURES = [
  {
    icon: '🔗',
    title: 'Multi-Exchange Support',
    desc: 'Connect Binance, Bybit, Coinbase, Kraken, OKX, and Ethereum wallets. All balances aggregated into a single unified view.'
  },
  {
    icon: '⚡',
    title: 'Real-Time Positions',
    desc: 'Live futures positions updated every 5 seconds. Track unrealized PnL, leverage, entry prices, and liquidation levels.'
  },
  {
    icon: '📅',
    title: 'P&L Calendar',
    desc: 'See your daily profit and loss at a glance with a color-coded calendar. Instantly spot winning and losing streaks.'
  },
  {
    icon: '📈',
    title: 'Portfolio Evolution',
    desc: 'Historical chart of your total portfolio value with daily snapshots. Track your growth from day one.'
  }
]

const STEPS = [
  {
    n: '01',
    title: 'Create your account',
    desc: 'Sign up with email and password in seconds. Your data is private and belongs only to you.'
  },
  {
    n: '02',
    title: 'Connect your exchanges',
    desc: 'Add read-only API keys from your exchanges. All keys are encrypted with AES-256 at rest.'
  },
  {
    n: '03',
    title: 'Track everything',
    desc: 'Your full portfolio, open positions, P&L history — in one clean, fast dashboard.'
  }
]

export default function Landing({ isLoggedIn = false }) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="landing">

      {/* ─── Nav ─────────────────────────────────────────── */}
      <nav className="lnav">
        <div className="lnav-inner">
          <div className="lnav-logo">
            <div className="lnav-logo-icon">₿</div>
            <span>assetfol.io</span>
          </div>

          <button className="lnav-hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Menu">
            <span /><span /><span />
          </button>

          <div className={`lnav-links${menuOpen ? ' open' : ''}`}>
            {isLoggedIn ? (
              <button className="btn-primary lnav-btn" onClick={() => { navigate('/dashboard'); setMenuOpen(false) }}>Go to Dashboard</button>
            ) : (
              <>
                <button className="btn-ghost lnav-btn" onClick={() => { navigate('/login'); setMenuOpen(false) }}>Login</button>
                <button className="btn-primary lnav-btn" onClick={() => { navigate('/register'); setMenuOpen(false) }}>Get Started</button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ─── Hero ────────────────────────────────────────── */}
      <section className="lhero">
        <div className="lhero-glow" />
        <div className="lsection-inner">
          <div className="lbadge">✦ Portfolio Tracker</div>
          <h1 className="lhero-h1">Track all your assets<br className="lhero-br" /> in one place</h1>
          <p className="lhero-sub">
            Connect your crypto exchanges, wallets, and brokers.
            Monitor real-time positions, P&L, and portfolio evolution — all from a single dashboard.
          </p>
          <div className="lhero-ctas">
            {isLoggedIn ? (
              <button className="btn-primary lbtn-lg" onClick={() => navigate('/dashboard')}>Go to Dashboard</button>
            ) : (
              <>
                <button className="btn-primary lbtn-lg" onClick={() => navigate('/register')}>Get Started Free</button>
                <button className="btn-ghost lbtn-lg" onClick={() => navigate('/login')}>Sign In</button>
              </>
            )}
          </div>
          <div className="lhero-supported">
            <span className="lhero-supported-label">Supports</span>
            <div className="lhero-tags">
              {EXCHANGES.map(e => <span key={e} className="lhero-tag">{e}</span>)}
            </div>
          </div>
        </div>
      </section>

      {/* ─── Features ────────────────────────────────────── */}
      <section className="lsection">
        <div className="lsection-inner">
          <p className="lsection-eyebrow">Features</p>
          <h2 className="lsection-title">Everything you need</h2>
          <p className="lsection-sub">One platform for all your crypto assets</p>
          <div className="lfeatures-grid">
            {FEATURES.map(f => (
              <div key={f.title} className="lfeature-card">
                <div className="lfeature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How it works ────────────────────────────────── */}
      <section className="lsection lsection-alt">
        <div className="lsection-inner">
          <p className="lsection-eyebrow">Process</p>
          <h2 className="lsection-title">How it works</h2>
          <p className="lsection-sub">Up and running in under 3 minutes</p>
          <div className="lsteps-grid">
            {STEPS.map((s, i) => (
              <div key={s.n} className="lstep-card">
                {i < STEPS.length - 1 && <div className="lstep-connector" />}
                <div className="lstep-number">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Bottom CTA ──────────────────────────────────── */}
      <section className="lsection lcta-section">
        <div className="lcta-glow" />
        <div className="lsection-inner lcta-inner">
          <h2 className="lcta-title">Start tracking today</h2>
          <p className="lcta-sub">Free to use. No credit card required.</p>
          {isLoggedIn ? (
            <button className="btn-primary lbtn-lg" onClick={() => navigate('/dashboard')}>Go to Dashboard</button>
          ) : (
            <button className="btn-primary lbtn-lg" onClick={() => navigate('/register')}>Get Started Free</button>
          )}
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────── */}
      <footer className="lfooter">
        <div className="lsection-inner lfooter-inner">
          <div className="lnav-logo">
            <div className="lnav-logo-icon" style={{ width: 28, height: 28, fontSize: 14 }}>₿</div>
            <span style={{ fontSize: 14, color: '#475569' }}>assetfol.io</span>
          </div>
          <p className="lfooter-copy">© {new Date().getFullYear()} assetfol.io — All rights reserved</p>
        </div>
      </footer>
    </div>
  )
}
