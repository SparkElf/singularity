import * as React from "react"

const MOBILE_BREAKPOINT = 720

export function useIsMobile() {
  return React.useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
      mql.addEventListener("change", onStoreChange)
      return () => mql.removeEventListener("change", onStoreChange)
    },
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  )
}
