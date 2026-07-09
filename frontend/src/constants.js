export const API = import.meta.env.VITE_API_URL || 'https://asset-dashboard-production-425c.up.railway.app'

export const EXCHANGE_TYPES = {
  binance: { label: 'Binance', color: '#f59e0b' },
  bybit: { label: 'Bybit', color: '#14b8a6' },
  coinbase: { label: 'Coinbase', color: '#0052ff' },
  kraken: { label: 'Kraken', color: '#5741d9' },
  okx: { label: 'OKX', color: '#e6f0ff' },
  wallet_eth: { label: 'Wallet ETH', color: '#627eea' },
  trading212: { label: 'Trading 212', color: '#00c040' },
  global: { label: 'Global', color: '#6366f1' }
}
