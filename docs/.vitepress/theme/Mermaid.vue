<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ code: string }>()
const el = ref<HTMLElement>()
const { isDark } = useData()
let seq = 0

// A docs redeploy deletes the previous build's hashed chunks, so a viewer whose
// cached HTML references old hashes gets "Failed to fetch dynamically imported
// module" from mermaid's nested import()s. Retry once (CDN propagation blips),
// then reload the page once per session to pick up the fresh hashes.
const STALE_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i
const RELOAD_KEY = 'constella-docs-chunk-reload'

async function render(attempt = 0) {
  if (!el.value) return
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' })
    const { svg } = await mermaid.render(`mmd-${Date.now()}-${seq++}`, decodeURIComponent(props.code))
    el.value.innerHTML = svg
  } catch (e) {
    const raw = String((e as Error)?.message ?? e)
    if (STALE_RE.test(raw)) {
      if (attempt === 0) {
        setTimeout(() => render(1), 1500)
        return
      }
      if (!sessionStorage.getItem(RELOAD_KEY)) {
        sessionStorage.setItem(RELOAD_KEY, '1')
        location.reload()
        return
      }
    }
    const msg = raw.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    el.value.innerHTML = `<pre class="mermaid-error">⚠ Mermaid: ${msg}</pre>`
  }
}

onMounted(() => render())
watch(isDark, () => render())
</script>

<template>
  <div ref="el" class="mermaid-block" />
</template>
