<script setup lang="ts">
import { i18n, t, type LanguagePreference } from '@/i18n'

function change(event: Event) {
  i18n.setPreference((event.target as HTMLSelectElement).value as LanguagePreference)
}
</script>

<template>
  <div class="language-control">
    <select
      class="input language-select"
      data-testid="language-selector"
      :aria-label="t('Language')"
      :title="t('Language')"
      :value="i18n.preference.value"
      @change="change"
    >
      <option value="auto">{{ t('Browser language') }}</option>
      <option value="en" lang="en">English</option>
      <option value="zh-Hant" lang="zh-Hant">繁體中文</option>
    </select>
    <span v-if="!i18n.preferenceSaved.value" class="language-warning" role="status">{{
      t('Language choice could not be saved. It applies only to this tab.')
    }}</span>
  </div>
</template>

<style scoped>
.language-control {
  width: 152px;
  max-width: 100%;
}
.language-warning {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--warn);
  overflow-wrap: anywhere;
}
.language-select {
  width: 152px;
  max-width: 100%;
  min-height: 40px;
  font-family: inherit;
}
</style>
