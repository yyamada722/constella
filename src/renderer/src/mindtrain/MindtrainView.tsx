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
  // 路線図カード → plan jump: navigates here with { focusPlanId }.
  const location = useLocation()
  const requestStationFocus = useStore((s) => s.requestStationFocus)
  const switchPlan = useStore((s) => s.switchPlan)
  const handled = useRef('')
  useEffect(() => {
    const st = location.state as { focusStationId?: string; focusPlanId?: string } | null
    if ((!st?.focusStationId && !st?.focusPlanId) || handled.current === location.key) return
    handled.current = location.key
    if (st.focusPlanId) {
      // Only within the active project — a pasted card can reference a foreign plan.
      const s = useStore.getState()
      if (s.workspaceMeta[st.focusPlanId]?.projectId === s.activeProjectId) switchPlan(st.focusPlanId)
    }
    if (st.focusStationId) requestStationFocus(st.focusStationId)
  }, [location, requestStationFocus, switchPlan])

  return (
    <div className="mt-root">
      <MindtrainApp />
      <MtConfirmHost />
    </div>
  )
}
