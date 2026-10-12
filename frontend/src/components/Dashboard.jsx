import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { exact, formatBytes, formatKbps } from '../lib/format'
import { readError } from '../lib/socket'
import { TIER_COLORS } from '../lib/tiers'

const SENT = '#1F3A4D'
const FULL = '#AFBDC6'

function Chart({ title, data, empty }) {
  return (
    <div className="chart">
      <h3>{title}</h3>
      {data.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#D3DCE1" />
            <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickFormatter={formatBytes} width={56} tickLine={false} axisLine={false} fontSize={12} />
            <Tooltip formatter={(v) => `${formatBytes(v)} (${exact(v)} B)`} cursor={{ fill: 'rgba(31,58,77,0.06)' }} />
            <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="sent" name="Actually sent" fill={SENT} radius={[3, 3, 0, 0]} />
            <Bar dataKey="full" name="At full quality" fill={FULL} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function Dashboard({ config, snapshot, status, networkKbps, networkTier }) {
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState(null)

  const reset = async () => {
    setResetting(true)
    setError(null)
    try {
      const response = await fetch('/api/reset', { method: 'POST' })
      if (!response.ok) throw new Error(await readError(response))
    } catch (err) {
      setError(err.message)
    } finally {
      setResetting(false)
    }
  }

  if (!snapshot) {
    return (
      <section className="panel" aria-busy="true" aria-label="Dashboard">
        <h2>Dashboard</h2>
        <div className="skeleton" />
        <p className="muted">{status === 'reconnecting' ? 'Waiting for the backend…' : 'Connecting to the live feed…'}</p>
      </section>
    )
  }

  const { totals, receivers, history } = snapshot
  const avgUsage = receivers.length ? totals.bytes_sent / receivers.length : 0
  const perBroadcast = history
    .filter((h) => h.done > 0)
    .slice(-12)
    .map((h) => ({ name: `#${h.id}`, sent: h.actual_bytes, full: h.baseline_bytes }))
  const perReceiver = receivers
    .filter((r) => r.completed_baseline > 0)
    .map((r) => ({ name: r.id.replace(/^rx-/, '').toUpperCase(), sent: r.completed_actual, full: r.completed_baseline }))

  return (
    <section className="panel dashboard" aria-labelledby="dash-title">
      <div className="dash-head">
        <h2 id="dash-title">Dashboard</h2>
        <div className="row">
          {status !== 'open' && <span className="note error">Live feed disconnected. Retrying…</span>}
          <button type="button" className="btn ghost" onClick={reset} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset counters'}
          </button>
        </div>
      </div>
      {error && <p className="note error" role="alert">{error}</p>}

      <dl className="readouts">
        <div>
          <dt>Network tier</dt>
          <dd style={{ color: TIER_COLORS[networkTier.key] }}>{networkTier.label}</dd>
        </div>
        <div>
          <dt>Bitrate (simulated)</dt>
          <dd>{formatKbps(networkKbps)}</dd>
        </div>
        <div>
          <dt>Bytes sent</dt>
          <dd>{exact(totals.bytes_sent)}</dd>
        </div>
        <div>
          <dt>Data per receiver</dt>
          <dd>{formatBytes(Math.round(avgUsage))}</dd>
        </div>
        <div>
          <dt>Estimated savings</dt>
          <dd>{totals.completed_baseline ? `${totals.saved_pct}%` : 'None yet'}</dd>
          {totals.completed_baseline > 0 && <span className="sub">{formatBytes(totals.saved_bytes)} not sent</span>}
        </div>
      </dl>

      <p className="muted small basis">
        Bytes are the exact size of every WebSocket frame sent. Savings compare that with what a high-tier receiver would
        have been sent for the same broadcasts, so they are an estimate. Bitrate is the capacity you set, not a measurement.
        {totals.broadcasts > 0 && ` ${totals.broadcasts} broadcast${totals.broadcasts === 1 ? '' : 's'}, ${totals.media_failed} media failure${totals.media_failed === 1 ? '' : 's'}.`}
        {totals.in_flight > 0 && ` ${totals.in_flight} deliver${totals.in_flight === 1 ? 'y' : 'ies'} in progress.`}
      </p>
      <p className="muted small basis">
        Priority bytes — primary: {exact(totals.priority_bytes?.primary || 0)} B, secondary: {exact(totals.priority_bytes?.secondary || 0)} B,
        tertiary/media: {exact(totals.priority_bytes?.tertiary || 0)} B.
      </p>

      <div className="charts">
        <Chart title="Bytes per broadcast" data={perBroadcast} empty="Send a broadcast to see how much was sent versus full quality." />
        <Chart title="Bytes per receiver" data={perReceiver} empty="Receivers appear here after their first delivery finishes." />
      </div>
    </section>
  )
}
