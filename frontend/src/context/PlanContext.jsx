import { createContext, useContext, useEffect, useState } from 'react'
import axios from 'axios'

const PlanContext = createContext({ plan: 'free', isPro: false, loading: true, refresh: () => {} })

export function PlanProvider({ children }) {
  const [plan, setPlan] = useState('free')
  const [planData, setPlanData] = useState(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const { data } = await axios.get('/api/billing/plan')
      setPlan(data.plan || 'free')
      setPlanData(data)
    } catch {
      setPlan('free')
      setPlanData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) refresh()
    else setLoading(false)
  }, [])

  return (
    <PlanContext.Provider value={{ plan, planData, isPro: plan === 'pro', loading, refresh }}>
      {children}
    </PlanContext.Provider>
  )
}

export function usePlan() { return useContext(PlanContext) }
