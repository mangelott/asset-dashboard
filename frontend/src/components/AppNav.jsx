import { NavLink } from 'react-router-dom'

export default function AppNav() {
  return (
    <nav className="app-nav">
      <NavLink to="/dashboard" className={({ isActive }) => `app-nav-link ${isActive ? 'active' : ''}`}>Dashboard</NavLink>
      <NavLink to="/alerts" className={({ isActive }) => `app-nav-link ${isActive ? 'active' : ''}`}>Alertas</NavLink>
      <NavLink to="/paper-trading" className={({ isActive }) => `app-nav-link ${isActive ? 'active' : ''}`}>Paper Trading</NavLink>
    </nav>
  )
}
