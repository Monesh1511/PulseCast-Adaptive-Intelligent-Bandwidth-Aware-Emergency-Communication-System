import { formatBytes } from '../lib/format'

const formatNames = {
  full: 'Full quality',
  compressed: 'Compressed media',
  text: 'Text + audio',
  compact: 'Compact text',
}

function deliveryFormat(delivery = {}) {
  const summary = delivery.adaptive_summary || {}
  if (summary.tier === 'very_low') return 'compact'
  if (summary.tier === 'low') return 'text'
  if (summary.tier === 'medium') return 'compressed'
  return delivery.format || delivery.payload_format || 'full'
}

export default function AdaptiveDeliverySummary({ snapshot, receivers }) {
  const latest = snapshot?.history?.length ? snapshot.history[snapshot.history.length - 1] : null
  const delivery = latest?.delivery && typeof latest.delivery === 'object' ? latest.delivery : {}
  const entries = Object.entries(delivery)
  const tierCounts = entries.reduce((counts, [, item]) => {
    const tier = item?.adaptive_summary?.tier || item?.tier || 'unknown'
    counts[tier] = (counts[tier] || 0) + 1
    return counts
  }, {})
  const formatCounts = entries.reduce((counts, [, item]) => {
    const format = deliveryFormat(item)
    counts[format] = (counts[format] || 0) + 1
    return counts
  }, {})

  return (
    <section className="panel adaptive-summary" aria-labelledby="adaptive-summary-title">
      <div className="dash-head">
        <div>
          <h2 id="adaptive-summary-title">Adaptive Delivery Summary</h2>
          <p className="muted small">Per-receiver payload selection uses the existing simulated bandwidth tiers.</p>
        </div>
        {latest && <span className="note">Latest: Broadcast #{latest.id}</span>}
      </div>
      {!latest ? (
        <p className="empty">Send an announcement to see its adaptive delivery breakdown.</p>
      ) : (
        <>
          <div className="adaptive-summary-stats">
            <div><span className="muted small">Targeted</span><strong>{entries.length || latest.selected_count || receivers.length}</strong></div>
            <div><span className="muted small">Payload bytes</span><strong>{formatBytes(latest.adaptive_summary?.actual_bytes || latest.actual_bytes || 0)}</strong></div>
            <div><span className="muted small">Planned payload</span><strong>{formatBytes(latest.adaptive_summary?.planned_bytes || latest.baseline_bytes || 0)}</strong></div>
          </div>
          <div className="adaptive-summary-groups">
            <div>
              <strong>Receivers by tier</strong>
              <p className="muted small">{Object.entries(tierCounts).map(([tier, count]) => `${tier}: ${count}`).join(' · ') || 'No tier data reported'}</p>
            </div>
            <div>
              <strong>Selected formats</strong>
              <p className="muted small">{Object.entries(formatCounts).map(([format, count]) => `${formatNames[format] || format}: ${count}`).join(' · ') || 'No format data reported'}</p>
            </div>
          </div>
          <div className="adaptive-table-wrap">
            <table className="adaptive-table">
              <thead><tr><th>Receiver</th><th>Tier</th><th>Payload</th><th>Status</th><th>Bytes</th></tr></thead>
              <tbody>
                {entries.map(([id, item]) => (
                  <tr key={id}>
                    <th scope="row">{receivers.find((receiver) => receiver.id === id)?.name || id}</th>
                    <td>{item?.adaptive_summary?.tier || item?.tier || 'Unknown'}</td>
                    <td>{formatNames[deliveryFormat(item)] || deliveryFormat(item)}</td>
                    <td>{item?.status || 'Pending'}</td>
                    <td>{formatBytes(item?.adaptive_summary?.actual_bytes || item?.actual_bytes || item?.bytes || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
