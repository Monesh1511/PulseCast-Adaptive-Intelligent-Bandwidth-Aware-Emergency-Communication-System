// Browser-side helpers for recording and for grabbing a still frame from a video.

export function pickRecorderMime(kind) {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates =
    kind === 'video'
      ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

// Resolves to a JPEG Blob, or null if the browser cannot decode the video.
export function extractPosterFrame(blob, { maxWidth = 640, quality = 0.7 } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    let finished = false
    let timer = null

    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      URL.revokeObjectURL(url)
      resolve(result)
    }
    timer = setTimeout(() => finish(null), 5000)

    const draw = () => {
      if (!video.videoWidth) return finish(null)
      const scale = Math.min(1, maxWidth / video.videoWidth)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((b) => finish(b), 'image/jpeg', quality)
    }

    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.addEventListener('error', () => finish(null))
    video.addEventListener('seeked', draw)
    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = 0.2
      } catch {
        draw()
      }
    })
    video.src = url
  })
}
