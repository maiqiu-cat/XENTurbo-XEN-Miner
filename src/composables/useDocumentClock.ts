import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

export function useDocumentClock(
  intervalMs: number,
  enabled: () => boolean = () => true,
  readTime: () => number = Date.now,
  onResume?: () => void
): Ref<number> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('Clock interval must be a positive whole number')
  }

  const now = ref(readTime())
  let timer: ReturnType<typeof setInterval> | null = null
  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const start = () => {
    stop()
    if (!enabled() || !pageVisible()) return
    now.value = readTime()
    timer = setInterval(() => {
      now.value = readTime()
    }, intervalMs)
  }
  const resume = () => {
    if (enabled() && pageVisible()) onResume?.()
  }
  const onVisibilityChange = () => {
    start()
    resume()
  }
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      start()
      resume()
    }
  }

  watch(enabled, start)
  onMounted(() => {
    start()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    if (onResume && typeof window !== 'undefined') {
      window.addEventListener('focus', resume)
      window.addEventListener('pageshow', onPageShow)
    }
  })
  onUnmounted(() => {
    stop()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    if (onResume && typeof window !== 'undefined') {
      window.removeEventListener('focus', resume)
      window.removeEventListener('pageshow', onPageShow)
    }
  })

  return now
}
