import React, { useEffect, useState } from 'react'
import { ChannelView } from './ChannelView'

export function ChannelTab({ active }: { active: boolean }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div className="channel-tab" hidden={!active} aria-hidden={!active} {...(!active ? { inert: '' } : {})} style={{ height: '100%', minHeight: 0 }}>
    {(active || visited) && <ChannelView active={active} />}
  </div>
}
