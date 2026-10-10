import { useEffect, useRef, useState, type RefObject } from 'react'
import { Image as ImageIcon } from 'lucide-react'

export function thumbnailQueue() {
  let active = 0
  const jobs: (() => Promise<void>)[] = []
  const drain = () => {
    while (active < 2 && jobs.length) {
      const job = jobs.shift()!
      active++
      void job().finally(() => { active--; drain() })
    }
  }
  return (job: () => Promise<void>) => { jobs.push(job); drain() }
}

export function VisualThumbnail({ repositoryId, artifactId, root, enqueue }: {
  repositoryId: string
  artifactId: string
  root: RefObject<HTMLDivElement>
  enqueue: ReturnType<typeof thumbnailQueue>
}) {
  const element = useRef<HTMLSpanElement>(null)
  const objectUrl = useRef('')
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState('')
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { root: root.current })
    observer.observe(element.current!)
    return () => observer.disconnect()
  }, [root])
  useEffect(() => {
    let cancelled = false
    setUrl('')
    if (visible) enqueue(async () => {
      if (cancelled) return
      try {
        const result = await window.codeAwareness.getContinuumVisualThumbnail(repositoryId, artifactId)
        if (cancelled || result.repositoryId !== repositoryId || result.artifactId !== artifactId) return
        objectUrl.current = URL.createObjectURL(new Blob([new Uint8Array(result.data).buffer], { type: result.mimeType }))
        setUrl(objectUrl.current)
      } catch {}
    })
    return () => {
      cancelled = true
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = ''
    }
  }, [visible, repositoryId, artifactId, enqueue])
  const failed = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = ''; setUrl('')
  }
  return <span ref={element} className="continuum-thumbnail">
    {url ? <img src={url} alt="Miniatura da referência visual" onError={failed} /> : <ImageIcon size={24} aria-hidden="true" />}
  </span>
}
