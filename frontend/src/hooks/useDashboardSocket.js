import { useEffect, useState } from 'react'
import { backoff, wsUrl } from '../lib/socket'

// Live server-side statistics. Reconnects automatically.
export function useDashboardSocket() {
  const [snapshot, setSnapshot] = useState(null)
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    let cancelled = false
    let attempt = 0
    let timer = null
    let ws = null

    const connect = () => {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      ws = new WebSocket(wsUrl('/ws/dashboard'))
      ws.onopen = () => {
        attempt = 0
        setStatus('open')
      }
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'snapshot') setSnapshot(data)
        } catch {
          /* ignore malformed frame */
        }
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        if (cancelled) return
        setStatus('reconnecting')
        timer = setTimeout(connect, backoff(attempt++))
      }
    }

    connect()
    return () => {
      cancelled = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { snapshot, status }
}
