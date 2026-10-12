import { useMemo, useState } from 'react'

const initialStatus = (receivers) => Object.fromEntries(receivers.map((receiver) => [receiver.id, 'Waiting to send']))

export default function SendToReceivers({ receivers, draft, selected, onSelectionChange, onSend }) {
  const [results, setResults] = useState(() => initialStatus(receivers))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const selectedReceivers = useMemo(
    () => receivers.filter((receiver) => selected.includes(receiver.id)),
    [receivers, selected],
  )

  const setSelected = onSelectionChange

  const send = async () => {
    if (!selected.length || sending) return
    setSending(true)
    setError('')
    setResults(Object.fromEntries(selected.map((id) => [id, 'Sending…'])))
    try {
      const response = await onSend(selected)
      if (!response || response.error || !response.delivery || typeof response.delivery !== 'object') {
        throw new Error(response?.error || 'The backend returned an invalid delivery response.')
      }
      const next = { ...initialStatus(receivers) }
      for (const receiver of receivers) {
        const result = response.delivery?.[receiver.id]
        next[receiver.id] = result?.status === 'sent'
          ? 'Sent to connected receiver'
          : result?.status === 'failed'
            ? 'Failed'
            : result?.status === 'offline'
              ? 'Offline'
              : 'Not selected'
      }
      setResults(next)
    } catch (err) {
      setResults((current) => Object.fromEntries(
        Object.entries(current).map(([id, status]) => [id, status === 'Sending…' ? 'Failed' : status]),
      ))
      setError(err.message || 'Could not send the announcement.')
    } finally {
      setSending(false)
    }
  }

  const delivered = selectedReceivers.filter((receiver) => results[receiver.id] === 'Sent to connected receiver').length
  const offline = selectedReceivers.filter((receiver) => ['Offline', 'Failed'].includes(results[receiver.id])).length
  const percentage = selected.length ? Math.round((delivered / selected.length) * 100) : 0

  return (
    <section className="panel send-receivers" aria-labelledby="send-receivers-title">
      <h2 id="send-receivers-title">Send to Receivers</h2>
      <p className="muted small">Choose who receives your announcement and track delivery status.</p>

      <div className="receiver-selection-actions row wrap">
        <button type="button" className="btn ghost" onClick={() => setSelected(receivers.map((receiver) => receiver.id))}>Select All</button>
        <button type="button" className="btn ghost" onClick={() => setSelected([])}>Deselect All</button>
      </div>
      <div className="receiver-selection">
        {receivers.map((receiver) => (
          <label className="receiver-option" key={receiver.id}>
            <input type="checkbox" checked={selected.includes(receiver.id)} onChange={() => setSelected(selected.includes(receiver.id)
              ? selected.filter((value) => value !== receiver.id)
              : [...selected, receiver.id])} />
            <span>{receiver.name}</span>
            <small className={receiver.online ? 'status open' : 'status offline'}>{receiver.online ? 'Connected' : 'Offline'}</small>
          </label>
        ))}
      </div>

      <div className="send-preview">
        <h3>Message preview</h3>
        <p>{draft.text || 'No primary announcement entered yet.'}</p>
        {draft.secondary && <p><strong>Secondary:</strong> {draft.secondary}</p>}
        {draft.tertiary && <p><strong>Tertiary:</strong> {draft.tertiary}</p>}
        <span className="language-badge">{draft.language === 'ta' ? 'Tamil' : 'English'}</span>
      </div>

      <button type="button" className="btn primary" onClick={send} disabled={sending || !selected.length || !draft.text.trim()}>
        {sending ? 'Sending Announcement…' : 'Send Announcement'}
      </button>
      {error && <p className="note error" role="alert">{error}</p>}

      <div className="delivery-status" aria-live="polite">
        <h3>Delivery results</h3>
        <p className="muted small">
          Selected: {selected.length} · Successfully sent: {delivered} · Failed or offline: {offline} · Delivery: {percentage}%
        </p>
        {receivers.map((receiver) => (
          <div className="delivery-result" key={receiver.id}>
            <span>{receiver.name}</span>
            <span className={`delivery-pill ${results[receiver.id] === 'Sent to connected receiver' ? 'sent' : ''}`}>{results[receiver.id] || 'Waiting to send'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
