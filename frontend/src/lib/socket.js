export function wsUrl(path) {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${path}`
}

export function backoff(attempt) {
  return Math.min(8000, 500 * 2 ** attempt)
}

export async function readError(response) {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join('; ')
  } catch {
    /* not JSON */
  }
  return `Request failed (${response.status}).`
}
