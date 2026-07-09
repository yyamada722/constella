import { useEffect, useRef } from 'react'

// App-wide "click outside (or Escape) closes the popover" behavior for
// state-driven popovers/menus. Attach the returned ref to the popover container
// (include the trigger button inside the ref'd element, or the opening click
// will immediately re-close it — alternatively pass the trigger via `extraRef`).
//
//   const popRef = usePopoverDismiss<HTMLDivElement>(open, () => setOpen(false))
//   {open && <div ref={popRef} ...>...</div>}
//
// Uses pointerdown so the popover closes before the outside target's click
// handler runs (matching how native menus feel).
export function usePopoverDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  extraRef?: React.RefObject<HTMLElement | null>
): React.RefObject<T> {
  const ref = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current && ref.current.contains(t)) return
      if (extraRef?.current && extraRef.current.contains(t)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return ref
}
