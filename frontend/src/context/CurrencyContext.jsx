import { createContext, useContext, useEffect, useState } from 'react'
import axios from 'axios'

const CurrencyContext = createContext(null)

const RATE_REFRESH_MS = 60 * 60 * 1000 // 1h
const STORAGE_KEY = 'currency'

export function CurrencyProvider({ children }) {
  const [currency, setCurrencyState] = useState(() => localStorage.getItem(STORAGE_KEY) || 'USD')
  const [usdToEur, setUsdToEur] = useState(1)

  async function fetchRate() {
    try {
      const res = await axios.get('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR')
      const rate = res.data?.rates?.EUR
      if (rate) setUsdToEur(rate)
    } catch (e) {
      console.error('Currency rate error:', e.message)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount + periodic refresh
    fetchRate()
    const interval = setInterval(fetchRate, RATE_REFRESH_MS)
    return () => clearInterval(interval)
  }, [])

  function setCurrency(next) {
    localStorage.setItem(STORAGE_KEY, next)
    setCurrencyState(next)
  }

  function convert(usdValue) {
    return currency === 'EUR' ? usdValue * usdToEur : usdValue
  }

  function formatMoney(usdValue, decimals = 2) {
    const symbol = currency === 'EUR' ? '€' : '$'
    const value = convert(usdValue ?? 0)
    return `${symbol}${value.toFixed(decimals)}`
  }

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, convert, formatMoney }}>
      {children}
    </CurrencyContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook is tightly coupled to this context, splitting adds no value
export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider')
  return ctx
}
