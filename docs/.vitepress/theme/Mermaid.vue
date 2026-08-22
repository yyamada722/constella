<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ code: string }>()
const el = ref<HTMLElement>()
const { isDark } = useData()
let seq = 0

async function render() {
  if (!el.value) return
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' })
  try {
    const { svg } = await mermaid.render(`mmd-${Date.now()}-${seq++}`, decodeURIComponent(props.code))
    el.value.innerHTML = svg
  } catch (e) {
    el.value.innerHTML = `<pre class="mermaid-error">⚠ Mermaid: ${String((e as Error)?.message ?? e)}</pre>`
  }
}

onMounted(render)
watch(isDark, render)
</script>

<template>
  <div ref="el" class="mermaid-block" />
</template>
