import { TIER_COLORS } from '../lib/tiers'

export default function TierBadge({ tier }) {
  return (
    <span className="tier-badge" style={{ '--badge': TIER_COLORS[tier.key] }}>
      {tier.label}
    </span>
  )
}
