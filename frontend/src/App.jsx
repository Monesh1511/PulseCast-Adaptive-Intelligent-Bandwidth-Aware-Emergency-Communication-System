import { useCallback, useRef, useState } from 'react'
import Composer from './components/Composer'
import Dashboard from './components/Dashboard'
import AdaptiveDeliverySummary from './components/AdaptiveDeliverySummary'
import LiveReachability from './components/LiveReachability'
import NetworkControl from './components/NetworkControl'
import QrCodeGenerator from './components/QrCodeGenerator'
import RecipientDetailsQr from './components/RecipientDetailsQr'
import ReceiverPanel from './components/ReceiverPanel'
import SendToReceivers from './components/SendToReceivers'
import { useConfig } from './hooks/useConfig'
import { useDashboardSocket } from './hooks/useDashboardSocket'
import { formatKbps } from './lib/format'
import { TIER_COLORS, tierFor } from './lib/tiers'

const MAX_RECEIVERS = 6
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f']
const START_KBPS = 2000

const RECEIVER_NAMES = ['Aarthi', 'Monesh', 'Kabil', 'Jerold', 'Receiver E', 'Receiver F']
const makeReceiver = (letter, kbps, index = LETTERS.indexOf(letter)) => ({ id: `rx-${letter}`, name: RECEIVER_NAMES[index] || `Receiver ${letter.toUpperCase()}`, kbps, online: false })

export default function App() {
  const { config, loading, error, reload } = useConfig()
  const { snapshot, status } = useDashboardSocket()
  const [networkKbps, setNetworkKbps] = useState(START_KBPS)
  const [receivers, setReceivers] = useState(() => LETTERS.slice(0, 3).map((l) => makeReceiver(l, START_KBPS)))
  const [selectedReceiverIds, setSelectedReceiverIds] = useState(() => receivers.map((receiver) => receiver.id))
  const [draft, setDraft] = useState({ text: '', secondary: '', tertiary: '', language: 'en', summary: '' })
  const composerRef = useRef(null)
  const handleDraftChange = useCallback((nextDraft) => setDraft(nextDraft), [])

  if (!config) {
    return (
      <main className="boot">
        <h1>PulseCast Adaptive</h1>
        {loading && <p className="muted" aria-busy="true">Connecting to the backend…</p>}
        {error && (
          <div className="panel boot-error" role="alert">
            <h2>The backend is not reachable</h2>
            <p>{error}</p>
            <p className="muted">
              Start it from the <code>backend</code> folder with <code>uvicorn app.main:app --port 8000</code>, then retry.
            </p>
            <button type="button" className="btn primary" onClick={reload}>Retry</button>
          </div>
        )}
      </main>
    )
  }

  const networkTier = tierFor(config, networkKbps)
  const liveReceivers = receivers.map((receiver) => ({
    ...receiver,
    online: Boolean(snapshot?.receivers?.some((live) => live.id === receiver.id)),
    pending: snapshot?.reachability?.[receiver.id]?.pending || snapshot?.pending?.[receiver.id] || [],
  }))

  // The master slider drives every receiver; each receiver can then be tuned on its own.
  const setNetwork = (kbps) => {
    setNetworkKbps(kbps)
    setReceivers((list) => list.map((r) => ({ ...r, kbps })))
  }
  const addReceiver = () => {
    const letter = LETTERS.find((l) => !receivers.some((r) => r.id === `rx-${l}`))
    if (!letter) return
    const receiver = makeReceiver(letter, networkKbps)
    setReceivers((list) => [...list, receiver])
    setSelectedReceiverIds((current) => [...current, receiver.id])
  }
  const removeReceiver = (id) => {
    setReceivers((list) => list.filter((r) => r.id !== id))
    setSelectedReceiverIds((current) => current.filter((value) => value !== id))
  }

  return (
    <div className="app" style={{ '--tier': TIER_COLORS[networkTier.key] }}>
      <div className="band" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <h1>PulseCast Adaptive</h1>
          <p>One broadcast, delivered in whatever form each connection can carry. The text always gets through.</p>
        </div>
        <div className="readout" aria-live="polite">
          <span className="readout-tier">{networkTier.label} tier</span>
          <span className="readout-rate">{formatKbps(networkKbps)}</span>
        </div>
      </header>

      <div className="layout">
        <aside className="console">
          <NetworkControl config={config} kbps={networkKbps} onChange={setNetwork} />
          <Composer
            ref={composerRef}
            config={config}
            receiverCount={receivers.length}
            selectedReceiverIds={selectedReceiverIds}
            onDraftChange={handleDraftChange}
          />
        </aside>

        <main className="stage">
          <Dashboard config={config} snapshot={snapshot} status={status} networkKbps={networkKbps} networkTier={networkTier} />
          <AdaptiveDeliverySummary snapshot={snapshot} receivers={liveReceivers} />
          <LiveReachability config={config} snapshot={snapshot} receivers={liveReceivers} />
          <div className="qr-section-row">
            <QrCodeGenerator />
            <RecipientDetailsQr />
          </div>
          <SendToReceivers
            receivers={liveReceivers}
            draft={draft}
            selected={selectedReceiverIds}
            onSelectionChange={setSelectedReceiverIds}
            onSend={(ids) => composerRef.current?.send(ids)}
          />

          <section aria-labelledby="rx-title">
            <div className="rx-head">
              <h2 id="rx-title">Receivers</h2>
              <button type="button" className="btn ghost" onClick={addReceiver} disabled={receivers.length >= MAX_RECEIVERS}>
                Add receiver
              </button>
            </div>
            {receivers.length === 0 ? (
              <p className="empty panel">No receivers. Add one to start receiving broadcasts.</p>
            ) : (
              <div className="receiver-grid">
                {liveReceivers.map((r) => (
                  <ReceiverPanel
                    key={r.id}
                    receiver={r}
                    config={config}
                    onRemove={() => removeReceiver(r.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}
