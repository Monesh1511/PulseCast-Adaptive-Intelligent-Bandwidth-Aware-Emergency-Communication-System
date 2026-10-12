import { useCallback, useEffect, useRef, useState } from 'react'
import { pickRecorderMime } from '../lib/media'

const MAX_SECONDS = 10

// Records a short mic or camera clip. Low bitrates keep clips small on purpose.
export function useRecorder() {
  const [recording, setRecording] = useState(null) // 'audio' | 'video' | null
  const [seconds, setSeconds] = useState(0)
  const [stream, setStream] = useState(null)
  const [error, setError] = useState(null)
  const recorderRef = useRef(null)
  const tickRef = useRef(null)

  const cleanup = useCallback(() => {
    clearInterval(tickRef.current)
    recorderRef.current?.stream?.getTracks().forEach((t) => t.stop())
    recorderRef.current = null
    setStream(null)
    setRecording(null)
    setSeconds(0)
  }, [])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [])

  const start = useCallback(
    async (kind, onDone) => {
      setError(null)
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setError('This browser cannot record media. Upload a file instead.')
        return
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: kind === 'video' ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } : false,
        })
        const mimeType = pickRecorderMime(kind)
        const recorder = new MediaRecorder(media, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 32000,
          ...(kind === 'video' ? { videoBitsPerSecond: 500000 } : {}),
        })
        const chunks = []
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || `${kind}/webm` })
          cleanup()
          if (blob.size) onDone(blob)
          else setError('The recording was empty. Try again.')
        }
        recorderRef.current = recorder
        setStream(media)
        setRecording(kind)
        recorder.start()
        let elapsed = 0
        tickRef.current = setInterval(() => {
          elapsed += 1
          setSeconds(elapsed)
          if (elapsed >= MAX_SECONDS) stop()
        }, 1000)
      } catch (err) {
        cleanup()
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera or microphone permission was denied. Allow access in the browser, or upload a file.'
            : `Could not start recording: ${err.message}`,
        )
      }
    },
    [cleanup, stop],
  )

  useEffect(() => cleanup, [cleanup])

  return { recording, seconds, stream, error, start, stop, maxSeconds: MAX_SECONDS }
}
