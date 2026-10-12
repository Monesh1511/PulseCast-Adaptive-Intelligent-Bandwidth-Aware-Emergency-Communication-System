import { formatKbps } from '../lib/format'
import { kbpsToPos, ladderGradient, posToKbps, tierFor } from '../lib/tiers'

const PRESETS = [
  { kbps: 3000, label: 'Strong' },
  { kbps: 600, label: 'Fair' },
  { kbps: 150, label: 'Weak' },
  { kbps: 24, label: 'Barely there' },
]

// Slider that simulates network capacity for every receiver at once.
export default function NetworkControl({ config, kbps, onChange }) {
  const tier = tierFor(config, kbps)
  const ascending = [...config.tiers].sort((a, b) => a.min_kbps - b.min_kbps).filter((t) => t.min_kbps > 0)

  return (
    <section className="panel" aria-labelledby="net-title">
      <h2 id="net-title">Network capacity</h2>
      <p className="muted">Drag to simulate a better or worse link. Every receiver follows; you can still tune each one below.</p>

      <div className="ladder-wrap">
        <div className="ladder" style={{ background: ladderGradient(config) }} />
        <input
          className="ladder-input"
          type="range"
          min="0"
          max="100"
          step="0.25"
          value={kbpsToPos(config, kbps)}
          onChange={(e) => onChange(posToKbps(config, Number(e.target.value)))}
          aria-label="Simulated network capacity"
          aria-valuetext={`${formatKbps(kbps)}, ${tier.label} tier`}
        />
        {ascending.map((t) => (
          <span key={t.key} className="tick" style={{ left: `${kbpsToPos(config, t.min_kbps)}%` }}>
            {formatKbps(t.min_kbps)}
          </span>
        ))}
      </div>

      <p className="current">
        <strong className="current-rate">{formatKbps(kbps)}</strong>
        <span className="current-desc">{tier.label} tier: {tier.description.toLowerCase()}</span>
      </p>

      <div className="presets" role="group" aria-label="Capacity presets">
        {PRESETS.map((p) => (
          <button
            key={p.kbps}
            type="button"
            className="chip"
            aria-pressed={tierFor(config, kbps).key === tierFor(config, p.kbps).key}
            onClick={() => onChange(p.kbps)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  )
}
