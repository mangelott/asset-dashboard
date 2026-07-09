import { useState, Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import axios from 'axios'
import './App.css'
import Landing from './pages/Landing'

const AuthPage = lazy(() => import('./pages/AuthPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const SharedPortfolio = lazy(() => import('./pages/SharedPortfolio'))
const Alerts = lazy(() => import('./pages/Alerts'))
const PaperTrading = lazy(() => import('./pages/PaperTrading'))

function PageLoading() {
  return <div className="page-loading">Loading...</div>
}

// ─── App ──────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('token')
    if (t) axios.defaults.headers.common['Authorization'] = `Bearer ${t}`
    return t
  })

  function handleAuth(newToken) {
    localStorage.setItem('token', newToken)
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`
    setToken(newToken)
  }

  function handleLogout() {
    localStorage.removeItem('token')
    delete axios.defaults.headers.common['Authorization']
    setToken(null)
  }

  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Landing isLoggedIn={!!token} />} />
        <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <AuthPage onAuth={handleAuth} defaultMode="login" />} />
        <Route path="/register" element={token ? <Navigate to="/dashboard" replace /> : <AuthPage onAuth={handleAuth} defaultMode="register" />} />
        <Route path="/dashboard" element={token ? <DashboardPage onLogout={handleLogout} /> : <Navigate to="/login" replace />} />
        <Route path="/alerts" element={token ? <Alerts /> : <Navigate to="/login" replace />} />
        <Route path="/paper-trading" element={token ? <PaperTrading /> : <Navigate to="/login" replace />} />
        <Route path="/share/:token" element={<SharedPortfolio />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
