import { useEffect, useReducer, useRef, useState } from 'react'
import { backoff, wsUrl } from '../lib/socket'

const initial = { messages: [], bytes: 0 }
const encoder = new TextEncoder()

function blankMessage(id) {
  return {
    id, text: null, language: 'en', tier: null, compact: false, recovered: false, ts: Date.now(),
    attachments: [], media: {}, failed: {}, withheld: 0, bytes: 0, simMs: 0,
    priorityTexts: {}, priorityStatus: {},
  }
}

export function receiverReducer(state, action) {
  switch (action.type) {
    case 'frame': {
      const { frame, bytes, simMs } = action
      if (!frame || typeof frame !== 'object' || !Number.isFinite(bytes) || !Number.isFinite(simMs)) return state
      const id = frame.t === 'a' ? frame.i : frame.id
      if (!Number.isFinite(id)) return state
      let msg = state.messages.find((m) => m.id === id) ?? blankMessage(id)
      msg = { ...msg, bytes: msg.bytes + bytes, simMs: msg.simMs + simMs }

      if (frame.t === 'a') {
        // Compact very-low-tier frame: {t, i, m, x?}
        msg = {
          ...msg, text: frame.m, language: frame.language ?? 'en', tier: 'very_low',
          compact: true, withheld: frame.x ?? 0,
          priorityStatus: {
            primary: frame.shortened ? 'shortened' : 'delivered',
            ...(Array.isArray(frame.w) ? frame.w : []).reduce((out, p) => ({ ...out, [p]: 'withheld' }), {}),
          },
        }
      } else if (frame.type === 'announcement') {
        msg = {
          ...msg, text: frame.text, language: frame.language ?? 'en', tier: frame.tier,
          attachments: Array.isArray(frame.attachments) ? frame.attachments : [], ts: Number.isFinite(frame.ts) ? frame.ts * 1000 : Date.now(),
          priorityTexts: { ...msg.priorityTexts, primary: frame.text },
          priorityStatus: {
            ...msg.priorityStatus, primary: 'delivered',
            ...(Array.isArray(frame.withheld_priorities) ? frame.withheld_priorities : []).reduce((out, p) => ({ ...out, [p]: 'withheld' }), {}),
          },
        }
      } else if (frame.type === 'priority') {
        if (!['primary', 'secondary', 'tertiary'].includes(frame.priority) || typeof frame.text !== 'string') return state
        msg = {
          ...msg, language: frame.language ?? msg.language,
          priorityTexts: { ...msg.priorityTexts, [frame.priority]: frame.text },
          priorityStatus: { ...msg.priorityStatus, [frame.priority]: 'delivered' },
        }
      } else if (frame.type === 'media') {
        if (typeof frame.kind !== 'string' || typeof frame.mime !== 'string' || typeof frame.data !== 'string') return state
        const entry = { src: `data:${frame.mime};base64,${frame.data}`, variant: frame.variant, bytes }
        msg = { ...msg, media: { ...msg.media, [frame.kind]: entry } }
      } else if (frame.type === 'media_failed') {
        msg = { ...msg, failed: { ...msg.failed, [frame.kind]: frame.reason } }
      }

      const others = state.messages.filter((m) => m.id !== id)
      return {
        bytes: state.bytes + bytes,
        messages: [msg, ...others].sort((a, b) => b.id - a.id).slice(0, 25),
      }
    }
    case 'recovered': {
      const known = new Set(state.messages.map((m) => m.id))
      const added = action.items
        .filter((item) => !known.has(item.id))
        .map((item) => ({ ...blankMessage(item.id), text: item.text, language: item.language ?? 'en', ts: item.ts * 1000, recovered: true }))
      if (!added.length) return state
      return { ...state, messages: [...added, ...state.messages].sort((a, b) => b.id - a.id).slice(0, 25) }
    }
    default:
      return state
  }
}

// One simulated receiver = one WebSocket. `kbps` is the simulated link capacity the server
// uses to pick the delivery tier; changing it re-registers the capacity immediately.
export function useReceiverSocket(id, kbps) {
  const [state, dispatch] = useReducer(receiverReducer, initial)
  const [status, setStatus] = useState('connecting')
  const [acknowledgedIds, setAcknowledgedIds] = useState(() => new Set())
  const wsRef = useRef(null)
  const kbpsRef = useRef(kbps)
  const lastIdRef = useRef(0)

  useEffect(() => {
    kbpsRef.current = kbps
    const timer = setTimeout(() => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_bandwidth', kbps }))
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [kbps])

  useEffect(() => {
    let cancelled = false
    let attempt = 0
    let everOpen = false
    let timer = null
    let ws = null

    // Text-only recovery path: after a reconnect, fetch announcements we missed over plain HTTP.
    const recover = async () => {
      try {
        const query = everOpen
          ? `since=${lastIdRef.current}&receiver_id=${encodeURIComponent(id)}`
          : `since=0&limit=0&receiver_id=${encodeURIComponent(id)}`
        const response = await fetch(`/api/announcements?${query}`)
        if (!response.ok) return
        const body = await response.json()
        if (!everOpen) lastIdRef.current = body.latest_id
        else if (body.items.length) {
          dispatch({ type: 'recovered', items: body.items })
          lastIdRef.current = Math.max(lastIdRef.current, ...body.items.map((i) => i.id))
        }
        everOpen = true
      } catch {
        /* best effort */
      }
    }

    const connect = () => {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      ws = new WebSocket(wsUrl(`/ws/receiver/${encodeURIComponent(id)}?kbps=${Math.round(kbpsRef.current)}`))
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setStatus('open')
        recover()
      }
      ws.onmessage = (event) => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          return
        }
        const bytes = encoder.encode(event.data).length // measured on the receiving side
        const simMs = ((bytes * 8) / (kbpsRef.current * 1000)) * 1000
        const fid = frame.t === 'a' ? frame.i : frame.id
        if (typeof fid === 'number') lastIdRef.current = Math.max(lastIdRef.current, fid)
        dispatch({ type: 'frame', frame, bytes, simMs })
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
  }, [id])

  const acknowledge = (announcementId) => {
    if (!Number.isInteger(announcementId) || announcementId <= 0) return false
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'ack', id: announcementId }))
    setAcknowledgedIds((current) => new Set(current).add(announcementId))
    return true
  }

  const retry = (announcementId) => {
    if (!Number.isInteger(announcementId) || announcementId <= 0) return false
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'retry', id: announcementId }))
    return true
  }

  return { ...state, status, acknowledgedIds, acknowledge, retry }
}
