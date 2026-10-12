export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function formatKbps(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`
}

export function formatSeconds(ms) {
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`
}

export const exact = (n) => new Intl.NumberFormat().format(n)
