import { useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'

const QR_EXPIRY_MINUTES = 15

function createRecipient() {
  return { name: '', id: '', contact: '', credential: '' }
}

function createAccessToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createQrPayload(recipient) {
  return JSON.stringify({
    type: 'pulsecast-recipient',
    recipientId: recipient.id.trim(),
    recipientName: recipient.name.trim(),
    accessToken: createAccessToken(),
    expiresAt: new Date(Date.now() + QR_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  })
}

export default function RecipientDetailsQr() {
  const [open, setOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [recipients, setRecipients] = useState([createRecipient()])
  const [generated, setGenerated] = useState([])
  const [error, setError] = useState('')
  const canvasRefs = useRef({})

  const updateRecipient = (index, field, value) => {
    setRecipients((current) => current.map((recipient, itemIndex) => (
      itemIndex === index ? { ...recipient, [field]: value } : recipient
    )))
    setError('')
  }

  const addRecipient = () => {
    setRecipients((current) => [...current, createRecipient()])
    setError('')
  }

  const removeRecipient = (index) => {
    setRecipients((current) => current.filter((_, itemIndex) => itemIndex !== index))
    setError('')
  }

  const generate = () => {
    if (recipients.length === 0) {
      setError('Add at least one recipient before generating QR codes.')
      return
    }
    const missingIndex = recipients.findIndex((recipient) => !recipient.name.trim() || !recipient.id.trim())
    if (missingIndex >= 0) {
      setError(`Enter a full name and recipient ID for recipient ${missingIndex + 1}.`)
      return
    }
    const seen = new Set()
    const duplicate = recipients.find((recipient) => {
      const id = recipient.id.trim().toLowerCase()
      if (seen.has(id)) return true
      seen.add(id)
      return false
    })
    if (duplicate) {
      setError('Each recipient ID must be unique.')
      return
    }

    setGenerated(recipients.map((recipient) => ({
      ...recipient,
      qrValue: createQrPayload(recipient),
    })))
    setError('')
  }

  const generateAgain = () => {
    setGenerated(recipients.map((recipient) => ({
      ...recipient,
      qrValue: createQrPayload(recipient),
    })))
  }

  const download = (recipient) => {
    const canvas = canvasRefs.current[recipient.id]
    if (!canvas) return
    const link = document.createElement('a')
    const safeId = recipient.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
    link.download = `pulsecast-recipient-${safeId}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const close = () => {
    setOpen(false)
    setShowInfo(false)
    setError('')
  }

  return (
    <>
      <section className="recipient-qr-launch panel" aria-labelledby="recipient-qr-title">
        <div>
          <h2 id="recipient-qr-title">Recipient QR Sharing</h2>
          <p className="muted small">Create a separate, expiring recipient access QR without changing the standard QR generator.</p>
        </div>
        <div className="recipient-qr-actions">
          <button type="button" className="btn primary" onClick={() => setOpen(true)}>
            Enter Recipient Details
          </button>
          <button
            type="button"
            className="info-button"
            aria-label="About recipient details"
            aria-expanded={showInfo}
            onClick={() => setShowInfo((current) => !current)}
          >
            i
          </button>
          {showInfo && (
            <p className="info-tooltip" role="status">
              Add recipient details to generate a unique QR code for each person.
            </p>
          )}
        </div>
      </section>

      {open && (
        <div className="recipient-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close()
        }}>
          <section className="recipient-modal panel" role="dialog" aria-modal="true" aria-labelledby="recipient-modal-title">
            <div className="dash-head">
              <div>
                <h2 id="recipient-modal-title">Enter Recipient Details</h2>
                <p className="muted small">Each QR contains a short-lived access token, not credentials or secrets.</p>
              </div>
              <button type="button" className="btn ghost" onClick={close}>Close</button>
            </div>

            <div className="recipient-form-list">
              {recipients.map((recipient, index) => (
                <div className="recipient-form-card" key={`${index}-${recipient.id}`}>
                  <div className="recipient-form-heading">
                    <strong>Recipient {index + 1}</strong>
                    <button type="button" className="btn ghost remove" onClick={() => removeRecipient(index)} disabled={recipients.length === 1}>
                      Remove
                    </button>
                  </div>
                  <div className="recipient-fields">
                    <label className="field">
                      <span>Full name <b aria-hidden="true">*</b></span>
                      <input value={recipient.name} onChange={(event) => updateRecipient(index, 'name', event.target.value)} placeholder="Full name" />
                    </label>
                    <label className="field">
                      <span>Recipient ID <b aria-hidden="true">*</b></span>
                      <input value={recipient.id} onChange={(event) => updateRecipient(index, 'id', event.target.value)} placeholder="Unique ID" />
                    </label>
                    <label className="field">
                      <span>Email or phone <em>(optional)</em></span>
                      <input value={recipient.contact} onChange={(event) => updateRecipient(index, 'contact', event.target.value)} placeholder="Email or phone" />
                    </label>
                    <label className="field">
                      <span>Credential/access info <em>(demo only, never encoded)</em></span>
                      <input value={recipient.credential} onChange={(event) => updateRecipient(index, 'credential', event.target.value)} placeholder="Optional mock credential" />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="row wrap">
              <button type="button" className="btn ghost" onClick={addRecipient}>+ Add Another Recipient</button>
              <button type="button" className="btn primary" onClick={generate}>Generate QR Codes</button>
            </div>
            <p className="muted small recipient-security-note">
              Demo safety: credential fields are never placed in the QR code. Share real secrets through a separate trusted channel.
            </p>
            {error && <p className="note error" role="alert">{error}</p>}

            {generated.length > 0 && (
              <div className="recipient-results" aria-live="polite">
                <div className="recipient-results-heading">
                  <div>
                    <h3>Generated recipient QR codes</h3>
                    <p className="muted small">Tokens expire after {QR_EXPIRY_MINUTES} minutes.</p>
                  </div>
                  <button type="button" className="btn ghost" onClick={generateAgain}>Generate Again</button>
                </div>
                <div className="recipient-qr-grid">
                  {generated.map((recipient) => (
                    <article className="recipient-qr-card" key={recipient.id}>
                      <QRCodeCanvas
                        value={recipient.qrValue}
                        size={220}
                        level="M"
                        includeMargin
                        bgColor="#ffffff"
                        fgColor="#000000"
                        ref={(canvas) => { canvasRefs.current[recipient.id] = canvas }}
                        aria-label={`QR code for ${recipient.name}`}
                      />
                      <strong>{recipient.name}</strong>
                      <span className="muted small">ID: {recipient.id}</span>
                      <button type="button" className="btn ghost" onClick={() => download(recipient)}>Download QR</button>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
