import { useCallback, useEffect, useState } from 'react'
import { readError } from '../lib/socket'

export function useConfig() {
  const [state, setState] = useState({ config: null, loading: true, error: null })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const response = await fetch('/api/config')
      if (!response.ok) throw new Error(await readError(response))
      setState({ config: await response.json(), loading: false, error: null })
    } catch (err) {
      setState({ config: null, loading: false, error: err.message || 'Could not reach the backend.' })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { ...state, reload: load }
}
