import { useReceiverSocket } from '../hooks/useReceiverSocket'
import { exact, formatBytes, formatKbps, formatSeconds } from '../lib/format'

const KINDS = ['audio', 'image', 'video']
const STATUS_TEXT = { open: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…' }

function Attachment({ kind, msg }) {
  const media = msg.media[kind]
  const failed = msg.failed[kind]
  const planned = msg.attachments.find((a) => a.kind === kind)
  const label = kind[0].toUpperCase() + kind.slice(1)

  if (media) {
    return (
      <figure className="media">
        {kind === 'audio' && <audio controls src={media.src} />}
        {kind === 'image' && <img src={media.src} alt="Attached to the announcement" />}
        {kind === 'video' &&
          (media.variant === 'frame' ? (
            <img src={media.src} alt="A single frame from the video" />
          ) : (
            <video controls src={media.src} />
          ))}
        <figcaption>
          {kind === 'video' && media.variant === 'frame' ? 'Video frame instead of video' : `${label}${media.variant === 'compressed' ? ' (compressed)' : ''}`}
          {', '}
          {formatBytes(media.bytes)} on the wire
        </figcaption>
      </figure>
    )
  }
  if (failed) {
    return <p className="note error">{label} did not arrive: {failed}. The announcement text above still did.</p>
  }
  if (planned?.status === 'skipped') {
    return <p className="note">{label} not sent: {planned.reason}.</p>
  }
  if (planned) {
    return <p className="note pending">{label} is arriving…</p>
  }
  return null
}

export function Message({ msg, kbps, acknowledged, onAcknowledge, onRetry }) {
  const hasAttachments = KINDS.some((k) => msg.media[k] || msg.failed[k] || msg.attachments.some((a) => a.kind === k))
  return (
    <article className={`message${msg.compact ? ' compact' : ''}`}>
      <header>
        <strong>Broadcast #{msg.id}</strong>
        <span className="language-badge">{msg.language === 'ta' ? 'Tamil' : 'English'}</span>
        <span className="muted small">
          {formatBytes(msg.bytes)} received, about {formatSeconds(msg.simMs)} at {formatKbps(kbps)}
        </span>
      </header>
      {msg.text ? <p className="body">{msg.text}</p> : <p className="note">Announcement text was not received.</p>}
      {Object.entries(msg.priorityTexts)
        .filter(([priority]) => priority !== 'primary')
        .map(([priority, value]) => (
          <p className="body" key={priority}><strong>{priority[0].toUpperCase() + priority.slice(1)}:</strong> {value}</p>
        ))}
      {Object.entries(msg.priorityStatus).some(([, state]) => state === 'withheld') && (
        <p className="note">Withheld for this bandwidth: {Object.entries(msg.priorityStatus)
          .filter(([, state]) => state === 'withheld').map(([priority]) => priority).join(', ')}.</p>
      )}
      {Object.entries(msg.priorityStatus).some(([, state]) => state === 'shortened') && (
        <p className="note">Shortened for this bandwidth: {Object.entries(msg.priorityStatus)
          .filter(([, state]) => state === 'shortened').map(([priority]) => priority).join(', ')}.</p>
      )}
      {msg.compact && <p className="muted small">Compact alert{msg.withheld ? `. ${msg.withheld} attachment${msg.withheld === 1 ? '' : 's'} withheld to save data.` : '.'}</p>}
      {msg.recovered && <p className="muted small">Recovered over a text-only request after reconnecting.</p>}
      {!acknowledged && (
        <button type="button" className="btn ghost acknowledge-button" onClick={() => onAcknowledge(msg.id)}>
          Acknowledge
        </button>
      )}
      {acknowledged && <p className="muted small">Acknowledged by receiver.</p>}
      {msg.recovered && !acknowledged && (
        <button type="button" className="btn ghost acknowledge-button" onClick={() => onRetry(msg.id)}>
          Retry Now
        </button>
      )}
      {hasAttachments && KINDS.map((k) => <Attachment key={k} kind={k} msg={msg} />)}
    </article>
  )
}

export default function ReceiverPanel({ receiver, onRemove }) {
  const { messages, bytes, status, acknowledgedIds, acknowledge, retry } = useReceiverSocket(receiver.id, receiver.kbps)

  return (
    <section className="panel receiver" aria-label={receiver.name}>
      <header className="receiver-head">
        <div>
          <h3>{receiver.name}</h3>
          <p className={`status ${status}`}>{STATUS_TEXT[status]}</p>
        </div>
      </header>

      <p className="muted small">
        Received {formatBytes(bytes)} ({exact(bytes)} B) in {messages.length} message{messages.length === 1 ? '' : 's'}
      </p>

      <div className="feed">
        {messages.length === 0 ? (
          <p className="empty">No announcements received yet.</p>
        ) : (
          messages.map((m) => (
            <Message
              key={m.id}
              msg={m}
              kbps={receiver.kbps}
              acknowledged={acknowledgedIds.has(m.id)}
              onAcknowledge={acknowledge}
              onRetry={retry}
            />
          ))
        )}
      </div>

      <button type="button" className="link remove" onClick={onRemove}>Remove receiver</button>
    </section>
  )
}
