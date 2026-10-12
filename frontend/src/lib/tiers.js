// Tier definitions come from the backend (/api/config). Only presentation lives here.
export const TIER_COLORS = {
  high: '#0E7C86',
  medium: '#B7791F',
  low: '#C2410C',
  very_low: '#9F1D4B',
}

export function tierFor(config, kbps) {
  return config.tiers.find((t) => kbps >= t.min_kbps) ?? config.tiers[config.tiers.length - 1]
}

// The slider is logarithmic: 8 kbps and 5,000 kbps both need usable resolution.
export function posToKbps(config, pos) {
  const ratio = config.max_kbps / config.min_kbps
  return Math.round(config.min_kbps * Math.pow(ratio, pos / 100))
}

export function kbpsToPos(config, kbps) {
  const ratio = config.max_kbps / config.min_kbps
  const clamped = Math.min(config.max_kbps, Math.max(config.min_kbps, kbps))
  return (100 * Math.log(clamped / config.min_kbps)) / Math.log(ratio)
}

// Hard-stop gradient so the slider track shows where each tier begins and ends.
export function ladderGradient(config) {
  const ascending = [...config.tiers].sort((a, b) => a.min_kbps - b.min_kbps)
  const stops = ascending.map((tier, i) => {
    const start = i === 0 ? 0 : kbpsToPos(config, tier.min_kbps)
    const end = i === ascending.length - 1 ? 100 : kbpsToPos(config, ascending[i + 1].min_kbps)
    return `${TIER_COLORS[tier.key]} ${start.toFixed(2)}% ${end.toFixed(2)}%`
  })
  return `linear-gradient(to right, ${stops.join(', ')})`
}
