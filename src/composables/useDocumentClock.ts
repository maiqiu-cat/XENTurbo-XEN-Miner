import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

export function useDocumentClock(
  intervalMs: number,
  enabled: () => boolean = () => true
): Ref<number> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('Clock interval must be a positive whole number')
  }

  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const start = () => {
    stop()
    if (!enabled() || !pageVisible()) return
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, intervalMs)
  }
  const onVisibilityChange = () => start()

  watch(enabled, start)
  onMounted(() => {
    start()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
  })
  onUnmounted(() => {
    stop()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  return now
}
