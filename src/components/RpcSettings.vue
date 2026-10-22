<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue'
import {
  CHAINS,
  MAX_RPC_INPUT_LENGTH,
  RPC_CHECK_CONCURRENCY,
  parseRpcInput,
  readCustomRpc,
  writeCustomRpc,
  type ChainKey
} from '@/config/chains'
import { resetProviders, validateRpcEndpoint } from '@/core/rpc'
import { mapWithConcurrency } from '@/utils/concurrency'

const props = defineProps<{ chain: ChainKey }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const open = ref(false)
const text = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
let contextRevision = 0

onScopeDispose(() => {
  contextRevision += 1
})

watch(
  () => props.chain,
  (c) => {
    contextRevision += 1
    text.value = readCustomRpc(c).join('\n')
    error.value = null
  },
  { immediate: true }
)

async function save() {
  if (saving.value) return
  error.value = null
  const targetChain = props.chain
  const revision = contextRevision
  const assertContext = () => {
    if (props.chain !== targetChain || contextRevision !== revision) {
      throw new Error('Network changed while RPC validation was running. Recheck and save again.')
    }
  }
  saving.value = true
  try {
    const urls = parseRpcInput(text.value)
    const checked = await mapWithConcurrency(urls, RPC_CHECK_CONCURRENCY, (url) => {
      assertContext()
      return validateRpcEndpoint(url, CHAINS[targetChain].chainId)
    })
    assertContext()
    writeCustomRpc(
      targetChain,
      checked.map((result) => result.url)
    )
    resetProviders()
    open.value = false
    emit('saved')
  } catch (err: any) {
    error.value = err?.message || 'RPC validation failed'
  } finally {
    saving.value = false
  }
}

function resetDefault() {
  error.value = null
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
          :maxlength="MAX_RPC_INPUT_LENGTH"
          v-model="text"
          :placeholder="CHAINS[chain].defaultRpcUrls.join('\n')"
        />
        <p v-if="error" class="rpc-error">{{ error }}</p>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? 'Checking...' : 'Save' }}
          </button>
          <button class="btn btn-ghost" :disabled="saving" @click="resetDefault">
            Reset to default
          </button>
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
.rpc-error {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
