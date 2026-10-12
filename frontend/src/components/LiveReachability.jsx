import { tierFor } from '../lib/tiers'

function latestDelivery(snapshot) {
  const history = snapshot?.history || []
  const latest = history.length ? history[history.length - 1] : null
  return latest?.delivery || {}
}

export default function LiveReachability({ config, snapshot, receivers }) {
  const delivery = latestDelivery(snapshot)
  const reachability = snapshot?.reachability || {}
  const pending = snapshot?.pending || {}
  const connected = receivers.filter((receiver) => receiver.online)
  const weak = receivers.filter((receiver) => ['low', 'very_low'].includes(tierFor(config, receiver.kbps).key))
  const statusFor = (receiver) => {
    const current = delivery[receiver.id]
    if (current?.status === 'acknowledged') return { key: 'acknowledged', label: 'Acknowledged' }
    if (current?.status === 'delivered' || current?.status === 'sent') return { key: 'delivered', label: 'Delivered' }
    if (current?.status === 'sending') return { key: 'pending', label: 'Pending Delivery' }
    if (current?.status === 'offline' || current?.status === 'failed') return { key: 'disconnected', label: current.status === 'failed' ? 'Delivery failed' : 'Disconnected' }
    if ((reachability[receiver.id]?.pending || pending[receiver.id] || []).length > 0) return { key: 'pending', label: 'Pending Delivery' }
    if (receiver.online && ['low', 'very_low'].includes(tierFor(config, receiver.kbps).key)) return { key: 'weak', label: 'Weak Network' }
    return { key: receiver.online ? 'connected' : 'disconnected', label: receiver.online ? 'Connected' : 'Disconnected' }
  }

  return (
    <section className="panel reachability" aria-labelledby="reachability-title">
      <div className="dash-head">
        <div>
          <h2 id="reachability-title">Live Reachability</h2>
          <p className="muted small">Connection state and delivery state are tracked separately.</p>
        </div>
      </div>
      <div className="reachability-metrics">
        <span><strong>{receivers.length}</strong> configured</span>
        <span><strong>{connected.length}</strong> connected</span>
        <span><strong>{receivers.length - connected.length}</strong> disconnected</span>
        <span><strong>{weak.length}</strong> weak network</span>
        <span><strong>{Object.values(delivery).filter((item) => ['sent', 'delivered', 'acknowledged'].includes(item?.status)).length}</strong> latest delivered</span>
        <span><strong>{Object.values(delivery).filter((item) => item?.status === 'acknowledged').length}</strong> acknowledged</span>
      </div>
      <div className="reachability-grid">
        {receivers.map((receiver) => {
          const status = statusFor(receiver)
          const pendingItems = reachability[receiver.id]?.pending || pending[receiver.id] || []
          return (
            <article className={`reachability-card ${status.key}`} key={receiver.id}>
              <span className="reachability-dot" aria-hidden="true" />
              <div><strong>{receiver.name}</strong><span className="muted small">{receiver.id}</span></div>
              <span className="reachability-label">{status.label}</span>
              {pendingItems.length > 0 && (
                <span className="reachability-pending">
                  {pendingItems.length} pending alert{pendingItems.length === 1 ? '' : 's'} · retry {pendingItems[0].attempts}/{pendingItems[0].max_retries}
                </span>
              )}
            </article>
          )
        })}
      </div>
      <div className="reachability-legend muted small">
        <span><i className="legend-dot connected" /> Connected</span>
        <span><i className="legend-dot weak" /> Weak network / pending</span>
        <span><i className="legend-dot disconnected" /> Disconnected / failed</span>
        <span><i className="legend-dot acknowledged" /> Acknowledged</span>
      </div>
    </section>
  )
}
