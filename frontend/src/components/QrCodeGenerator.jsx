import { useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'

// Conservative byte limit for QR error-correction level M.
const MAX_QR_BYTES = 2200

function byteLength(value) {
  return new TextEncoder().encode(value).length
}

export default function QrCodeGenerator() {
  const [content, setContent] = useState('')
  const [generated, setGenerated] = useState('')
  const [notice, setNotice] = useState(null)
  const canvasRef = useRef(null)

  const generate = () => {
    if (!content.trim()) {
      setGenerated('')
      setNotice({ kind: 'error', message: 'Enter text, a URL, or code before generating a QR code.' })
      return
    }
    if (byteLength(content) > MAX_QR_BYTES) {
      setGenerated('')
      setNotice({
        kind: 'error',
        message: `This content is too large for a QR code (${MAX_QR_BYTES} UTF-8 bytes maximum). Shorten it and try again.`,
      })
      return
    }
    setGenerated(content)
    setNotice({ kind: 'ok', message: 'QR code generated from the exact input. Scan it with any compatible QR reader.' })
  }

  const copyContent = async () => {
    if (!generated) return
    try {
      await navigator.clipboard.writeText(generated)
      setNotice({ kind: 'ok', message: 'Original content copied.' })
    } catch {
      setNotice({ kind: 'error', message: 'Could not access the clipboard. Select and copy the content manually.' })
    }
  }

  const downloadPng = () => {
    const canvas = canvasRef.current
    if (!canvas || !generated) return
    canvas.toBlob((blob) => {
      if (!blob) {
        setNotice({ kind: 'error', message: 'Could not create a PNG download.' })
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'pulsecast-qr.png'
      link.click()
      URL.revokeObjectURL(url)
      setNotice({ kind: 'ok', message: 'QR code PNG downloaded.' })
    }, 'image/png')
  }

  const clear = () => {
    setContent('')
    setGenerated('')
    setNotice(null)
  }

  return (
    <section className="panel qr-generator" aria-labelledby="qr-generator-title">
      <div className="dash-head">
        <div>
          <h2 id="qr-generator-title">QR Code Generator</h2>
          <p className="muted small">Generate a standard QR code for text, announcements, URLs, or code snippets.</p>
        </div>
      </div>

      <label className="field">
        <span>Enter text or code</span>
        <textarea
          rows="5"
          value={content}
          onChange={(event) => {
            setContent(event.target.value)
            if (notice?.kind === 'error') setNotice(null)
          }}
          placeholder="Enter an announcement, URL, short string, or code snippet."
          aria-describedby="qr-character-count"
        />
      </label>
      <p id="qr-character-count" className="muted small qr-count">
        {content.length} characters · {byteLength(content)} UTF-8 bytes
      </p>

      <div className="row wrap">
        <button type="button" className="btn primary qr-generate-button" onClick={generate}>Generate QR Code</button>
        <button type="button" className="btn ghost" onClick={copyContent} disabled={!generated}>Copy Content</button>
        <button type="button" className="btn ghost" onClick={downloadPng} disabled={!generated}>Download QR as PNG</button>
        <button type="button" className="btn ghost" onClick={clear}>Clear</button>
      </div>

      {notice && <p className={`note ${notice.kind === 'error' ? 'error' : 'ok'}`} role="alert">{notice.message}</p>}

      {generated && (
        <div className="qr-generator-preview">
          <div className="qr-preview">
            <QRCodeCanvas
              ref={canvasRef}
              value={generated}
              size={320}
              level="M"
              includeMargin
              bgColor="#ffffff"
              fgColor="#000000"
              aria-label="Generated QR code"
            />
            <p className="muted small">Scan this code to retrieve the exact content.</p>
          </div>
          <div className="qr-content-preview">
            <h3>Encoded content</h3>
            <pre>{generated}</pre>
          </div>
        </div>
      )}
    </section>
  )
}
