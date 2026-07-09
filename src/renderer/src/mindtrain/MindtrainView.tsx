// Constella host wrapper for the ported mindtrain app. Renders the metro-map
// UI inside a `.mt-root` container that carries mindtrain's scoped theme, so it
// fills Constella's content area without leaking styles into the rest of the app.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import MindtrainApp from './App'
import { useStore } from './store/useStore'
import { MtConfirmHost } from './confirm'
import './styles/scoped.css'

export default function MindtrainView() {
  // Card → station jump: Constella navigates here with { focusStationId }.
  const location = useLocation()
  const requestStationFocus = useStore((s) => s.requestStationFocus)
  const handled = useRef('')
  useEffect(() => {
    const st = location.state as { focusStationId?: string } | null
    if (!st?.focusStationId || handled.current === location.key) return
    handled.current = location.key
    requestStationFocus(st.focusStationId)
  }, [location, requestStationFocus])

  return (
    <div className="mt-root">
      <MindtrainApp />
      <MtConfirmHost />
    </div>
  )
}
