<template>
  <div class="code-compare">
    <div v-if="hasAgency" class="code-compare-col">
      <div class="code-compare-label label-agency">{{ leftLabel }}</div>
      <div class="code-compare-body">
        <slot name="agency" />
      </div>
    </div>
    <div v-if="hasTypescript" class="code-compare-col">
      <div class="code-compare-label label-ts">{{ rightLabel }}</div>
      <div class="code-compare-body">
        <slot name="typescript" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSlots, computed } from 'vue'

defineProps({
  leftLabel: { type: String, default: 'Agency' },
  rightLabel: { type: String, default: 'TypeScript' },
})

// Render only the panes that were actually given. When the `typescript`
// slot is omitted, the Agency pane is the sole flex child and fills the row.
const slots = useSlots()
const hasAgency = computed(() => !!slots.agency)
const hasTypescript = computed(() => !!slots.typescript)
</script>

<style scoped>
.code-compare {
  display: flex;
  gap: 16px;
  margin: 24px 0;
  align-items: stretch;
}

.code-compare-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.code-compare-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 4px 12px;
  border-radius: 8px 8px 0 0;
  width: fit-content;
}

.label-agency {
  color: var(--vp-button-brand-text);
  background: linear-gradient(135deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
}

.label-ts {
  color: var(--vp-c-text-2);
  background: var(--vp-c-default-soft);
}

/* Let each column's code block fill the column so both sides line up. */
.code-compare-body {
  flex: 1;
  display: flex;
}

.code-compare-body :deep(div[class*='language-']) {
  flex: 1;
  margin: 0;
  border-top-left-radius: 0;
}

/* Stack the two panes on narrow screens. */
@media (max-width: 768px) {
  .code-compare {
    flex-direction: column;
  }
}
</style>
