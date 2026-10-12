import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useRecorder } from '../hooks/useRecorder'
import { formatBytes } from '../lib/format'
import { extractPosterFrame } from '../lib/media'
import { readError } from '../lib/socket'

const EMPTY = { image: null, audio: null, video: null, poster: null }

const Composer = forwardRef(function Composer({ config, receiverCount, selectedReceiverIds, onDraftChange, onBroadcast }, ref) {
  const [text, setText] = useState('')
  const [secondary, setSecondary] = useState('')
  const [tertiary, setTertiary] = useState('')
  const [secondaryEnabled, setSecondaryEnabled] = useState(true)
  const [tertiaryEnabled, setTertiaryEnabled] = useState(true)
  const [language, setLanguage] = useState('en')
  const [translating, setTranslating] = useState(false)
  const [summary, setSummary] = useState('')
  const [summaryInfo, setSummaryInfo] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [files, setFiles] = useState(EMPTY)
  const [posterBusy, setPosterBusy] = useState(false)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState(null) // { kind: 'ok' | 'error', message }
  const recorder = useRecorder()
  const previewRef = useRef(null)

  useEffect(() => {
    onDraftChange?.({ text, secondary, tertiary, language, summary })
  }, [text, secondary, tertiary, language, summary, onDraftChange])

  const templates = {
    en: {
      flood: 'Flood warning: Avoid low-lying areas near [location]. Move to higher ground and follow instructions from local authorities.',
      cyclone: 'Cyclone warning for [location]: Stay indoors, secure loose items, and follow official evacuation instructions.',
      evacuation: 'Evacuation notice: Leave [location] by [time] via [destination]. Carry essential medicines and identification.',
      transport: 'Transport cancellation: Services between [location] and [destination] are cancelled on [date]. Check official updates before travelling.',
      safety: 'Public safety notice: Avoid [location] until [time]. Follow instructions from emergency personnel and check on vulnerable neighbours.',
    },
    ta: {
      flood: 'வெள்ள எச்சரிக்கை: [location] அருகிலுள்ள தாழ்வான பகுதிகளைத் தவிர்க்கவும். உயரமான இடத்திற்குச் சென்று உள்ளூர் அதிகாரிகளின் அறிவுறுத்தல்களைப் பின்பற்றவும்.',
      cyclone: 'புயல் எச்சரிக்கை [location]: வீட்டுக்குள் பாதுகாப்பாக இருக்கவும், தளர்வான பொருட்களைப் பாதுகாக்கவும், அதிகாரப்பூர்வ வெளியேற்ற அறிவுறுத்தல்களைப் பின்பற்றவும்.',
      evacuation: 'வெளியேற்ற அறிவிப்பு: [time] மணிக்குள் [location] இலிருந்து [destination] வழியாக வெளியேறவும். அத்தியாவசிய மருந்துகள் மற்றும் அடையாள அட்டையை எடுத்துச் செல்லவும்.',
      transport: 'போக்குவரத்து ரத்து: [date] அன்று [location] மற்றும் [destination] இடையிலான சேவைகள் ரத்து செய்யப்பட்டுள்ளன. பயணத்திற்கு முன் அதிகாரப்பூர்வ அறிவிப்புகளைச் சரிபார்க்கவும்.',
      safety: 'பொது பாதுகாப்பு அறிவிப்பு: [time] மணி வரை [location] பகுதியைத் தவிர்க்கவும். அவசரப் பணியாளர்களின் அறிவுறுத்தல்களைப் பின்பற்றவும்.',
    },
  }

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = recorder.stream
  }, [recorder.stream])

  const setFile = (kind, file) => {
    if (file && file.size > config.max_upload_bytes) {
      setNotice({ kind: 'error', message: `${file.name || 'That file'} is over ${formatBytes(config.max_upload_bytes)}.` })
      return
    }
    setNotice(null)
    setFiles((f) => ({ ...f, [kind]: file, ...(kind === 'video' ? { poster: null } : {}) }))
    if (kind === 'video' && file) {
      setPosterBusy(true)
      extractPosterFrame(file).then((poster) => {
        setFiles((f) => (f.video === file ? { ...f, poster } : f))
        setPosterBusy(false)
      })
    }
  }

  const record = (kind) => {
    if (recorder.recording) return recorder.stop()
    recorder.start(kind, (blob) => {
      const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'
      setFile(kind, new File([blob], `${kind}-clip.${ext}`, { type: blob.type }))
    })
  }

  const summarize = async () => {
    setSummarizing(true)
    setSummaryInfo(null)
    try {
      const response = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const data = await response.json()
      setSummary(data.summary)
      setSummaryInfo(data)
    } catch (err) {
      setSummaryInfo({ error: err.message })
    } finally {
      setSummarizing(false)
    }
  }

  const translate = async () => {
    if (!text.trim()) {
      setNotice({ kind: 'error', message: 'Write an announcement before translating it.' })
      return
    }
    setTranslating(true)
    setNotice(null)
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, primary: text, secondary, tertiary,
          secondary_enabled: secondaryEnabled, tertiary_enabled: tertiaryEnabled,
          target_language: language,
        }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const data = await response.json()
      const messages = data.messages || { primary: data.text }
      setText(messages.primary || '')
      setSecondary(messages.secondary || '')
      setTertiary(messages.tertiary || '')
      const warnings = Object.values(data.warnings || {}).filter(Boolean)
      setNotice({ kind: warnings.length ? 'error' : 'ok', message: warnings.join(' ') || `Translated to ${language === 'ta' ? 'Tamil' : 'English'}. Review and edit before sending.` })
    } catch (err) {
      setNotice({ kind: 'error', message: `${err.message} Emergency templates remain available below.` })
    } finally {
      setTranslating(false)
    }
  }

  const send = async (event, targetIds) => {
    event?.preventDefault()
    if (sending) return null
    if (!text.trim()) return setNotice({ kind: 'error', message: 'Write the announcement text first. It is always delivered, even when media fails.' })
    setSending(true)
    setNotice(null)
    try {
      const body = new FormData()
      body.append('text', text)
      body.append('language', language)
      body.append('summary', summary)
      body.append('secondary', secondary)
      body.append('tertiary', tertiary)
      body.append('secondary_enabled', String(secondaryEnabled))
      body.append('tertiary_enabled', String(tertiaryEnabled))
      body.append('receiver_ids', JSON.stringify(targetIds || selectedReceiverIds || []))
      body.append('simulate_media_failure', String(simulateFailure))
      for (const kind of ['image', 'audio', 'video']) {
        if (files[kind]) body.append(kind, files[kind], files[kind].name || kind)
      }
      if (files.video && files.poster) body.append('poster', files.poster, 'frame.jpg')
      const response = await fetch('/api/broadcast', { method: 'POST', body })
      if (!response.ok) throw new Error(await readError(response))
      const data = await response.json()
      onBroadcast?.(data)
      const smsItems = Array.isArray(data.sms?.results) ? data.sms.results : []
      const smsFailed = smsItems.some((item) => item.status === 'failed')
      const smsMessage = smsItems.length
        ? ` SMS: ${smsItems.map((item) => `${item.recipient} ${item.status === 'accepted' ? 'accepted' : `failed (${item.error})`}`).join('; ')}.`
        : ' SMS was not configured.'
      setNotice({
        kind: data.receivers && !smsFailed ? 'ok' : 'error',
        message: data.receivers
          ? `Broadcast #${data.id} is going out to ${data.receivers} receiver${data.receivers === 1 ? '' : 's'}.${smsMessage}`
          : `Broadcast #${data.id} was saved, but no receivers are connected.${smsMessage}`,
      })
      if (data.receivers) {
        setText('')
        setSecondary('')
        setTertiary('')
        setSummary('')
        setSummaryInfo(null)
        setFiles(EMPTY)
      }
      return data

    } catch (err) {
      const message = err.message || 'Could not reach the backend.'
      setNotice({ kind: 'error', message })
      return { error: message }
    } finally {
      setSending(false)
    }
  }

  useImperativeHandle(ref, () => ({ send: (targetIds) => send(undefined, targetIds) }), [send])

  const attached = ['audio', 'image', 'video'].filter((k) => files[k])

  return (
    <form className="panel composer" onSubmit={send} aria-labelledby="compose-title">
      <h2 id="compose-title">Broadcast</h2>

      <div className="row wrap language-controls">
        <label className="field language-select">
          <span>Announcement language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="ta">Tamil (தமிழ்)</option>
          </select>
        </label>
        <button type="button" className="btn ghost" onClick={translate} disabled={!text.trim() || translating}>
          {translating ? 'Translating…' : `Translate announcement to ${language === 'ta' ? 'Tamil' : 'English'}`}
        </button>
      </div>

      <label className="field">
        <span>Primary message / announcement ({language === 'ta' ? 'Tamil' : 'English'})</span>
        <textarea
          rows="5"
          value={text}
          maxLength={config.max_text_chars}
          onChange={(e) => setText(e.target.value)}
          placeholder="What does everyone need to know?"
        />
      </label>

      <fieldset className="attach priority-fields">
        <legend>Message Priority</legend>
        <p className="muted small">Primary is delivered first. Secondary and tertiary content may be withheld on slower tiers.</p>
        <label className="check">
          <input type="checkbox" checked={secondaryEnabled} onChange={(e) => setSecondaryEnabled(e.target.checked)} />
          <span>Enable secondary message</span>
        </label>
        {secondaryEnabled && <label className="field">
          <span>Secondary message</span>
          <textarea rows="2" value={secondary} maxLength={config.max_text_chars} onChange={(e) => setSecondary(e.target.value)} placeholder="Affected area, shelter, or next action" />
        </label>}
        <label className="check">
          <input type="checkbox" checked={tertiaryEnabled} onChange={(e) => setTertiaryEnabled(e.target.checked)} />
          <span>Enable tertiary message</span>
        </label>
        {tertiaryEnabled && <label className="field">
          <span>Tertiary message</span>
          <textarea rows="2" value={tertiary} maxLength={config.max_text_chars} onChange={(e) => setTertiary(e.target.value)} placeholder="Supporting details or optional guidance" />
        </label>}
      </fieldset>

      <label className="field">
        <span>Emergency template (optional)</span>
        <select defaultValue="" onChange={(e) => e.target.value && setText(templates[language][e.target.value])}>
          <option value="">Choose a reviewed template…</option>
          <option value="flood">Flood warning</option>
          <option value="cyclone">Cyclone warning</option>
          <option value="evacuation">Evacuation notice</option>
          <option value="transport">Transport cancellation</option>
          <option value="safety">Public safety</option>
        </select>
      </label>

      <div className="row">
        <button type="button" className="btn ghost" onClick={summarize} disabled={!text.trim() || summarizing}>
          {summarizing ? 'Summarizing…' : 'Summarize for very low bandwidth'}
        </button>
        <span className="muted small">{config.ai_enabled ? 'Using Groq' : 'Offline summary (no API key)'}</span>
      </div>

      {summaryInfo?.error && <p className="note error" role="alert">{summaryInfo.error}</p>}
      {summaryInfo && !summaryInfo.error && (
        <div className="summary">
          <label className="field">
            <span>Alert text for very low bandwidth ({summary.length}/160)</span>
            <textarea rows="2" value={summary} maxLength={240} onChange={(e) => setSummary(e.target.value)} />
          </label>
          {summaryInfo.warning && <p className="note">{summaryInfo.warning}</p>}
        </div>
      )}

      <fieldset className="attach">
        <legend>Attach media</legend>
        <div className="row wrap">
          <label className="btn ghost file-btn">
            Image
            <input type="file" accept="image/*" onChange={(e) => setFile('image', e.target.files[0] ?? null)} />
          </label>
          <label className="btn ghost file-btn">
            Audio
            <input type="file" accept="audio/*" onChange={(e) => setFile('audio', e.target.files[0] ?? null)} />
          </label>
          <label className="btn ghost file-btn">
            Video
            <input type="file" accept="video/*" onChange={(e) => setFile('video', e.target.files[0] ?? null)} />
          </label>
        </div>
        <div className="row wrap">
          <button type="button" className="btn ghost" onClick={() => record('audio')} disabled={recorder.recording === 'video'}>
            {recorder.recording === 'audio' ? `Stop recording (${recorder.seconds}s)` : 'Record audio'}
          </button>
          <button type="button" className="btn ghost" onClick={() => record('video')} disabled={recorder.recording === 'audio'}>
            {recorder.recording === 'video' ? `Stop recording (${recorder.seconds}s)` : 'Record video'}
          </button>
        </div>
        {recorder.recording === 'video' && <video ref={previewRef} className="preview" autoPlay muted playsInline />}
        {recorder.recording && <p className="muted small">Clips stop automatically after {recorder.maxSeconds} seconds.</p>}
        {recorder.error && <p className="note error" role="alert">{recorder.error}</p>}

        {attached.length > 0 && (
          <ul className="attached">
            {attached.map((kind) => (
              <li key={kind}>
                <span>
                  <strong>{kind}</strong> {files[kind].name} ({formatBytes(files[kind].size)})
                  {kind === 'video' && (posterBusy ? ', reading a preview frame…' : files.poster ? ', preview frame ready' : ', no preview frame')}
                </span>
                <button type="button" className="link" onClick={() => setFile(kind, null)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <label className="check">
        <input type="checkbox" checked={simulateFailure} onChange={(e) => setSimulateFailure(e.target.checked)} />
        <span>Fail all media on purpose to test the text fallback</span>
      </label>

      <button type="submit" className="btn primary" disabled={sending}>
        {sending ? 'Sending…' : `Send to ${receiverCount} receiver${receiverCount === 1 ? '' : 's'}`}
      </button>

      <div aria-live="polite">
        {notice && <p className={`note ${notice.kind === 'error' ? 'error' : 'ok'}`}>{notice.message}</p>}
      </div>
    </form>
  )
})

export default Composer
