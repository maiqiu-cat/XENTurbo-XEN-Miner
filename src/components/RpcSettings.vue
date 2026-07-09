<script setup lang="ts">
import { ref, watch } from 'vue'
import { CHAINS, readCustomRpc, writeCustomRpc, type ChainKey } from '@/config/chains'
import { resetProviders } from '@/core/rpc'

const props = defineProps<{ chain: ChainKey }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const open = ref(false)
const text = ref('')

watch(
  () => props.chain,
  (c) => {
    text.value = readCustomRpc(c).join('\n')
  },
  { immediate: true }
)

function save() {
  const urls = text.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  writeCustomRpc(props.chain, urls)
  resetProviders()
  open.value = false
  emit('saved')
}

function resetDefault() {
  writeCustomRpc(props.chain, [])
  resetProviders()
  text.value = ''
  open.value = false
  emit('saved')
}
</script>

<template>
  <span>
    <button class="btn btn-ghost" @click="open = true">RPC</button>
    <div v-if="open" class="modal-mask" @click.self="open = false">
      <div class="card modal-body">
        <div class="row between">
          <strong>{{ CHAINS[chain].name }} RPC endpoints</strong>
          <button class="btn btn-ghost" @click="open = false">x</button>
        </div>
        <p class="dim">One URL per line. Leave empty to use defaults. Helps with -32603 errors.</p>
        <textarea
          class="input"
          rows="4"
          v-model="text"
          :placeholder="CHAINS[chain].defaultRpcUrls.join('\n')"
        />
        <div class="row" style="margin-top: 12px">
          <button class="btn btn-primary" @click="save">Save</button>
          <button class="btn btn-ghost" @click="resetDefault">Reset to default</button>
        </div>
      </div>
    </div>
  </span>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal-body {
  width: 460px;
  max-width: 92vw;
}
textarea.input {
  resize: vertical;
  font-family: monospace;
}
</style>
