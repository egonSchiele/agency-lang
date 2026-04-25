<template>
  <div class="hero-with-code">
    <div class="hero-left">
      <h1 class="hero-name">Agency</h1>
      <p class="hero-tagline">A language for building agents.</p>
      <div class="hero-actions">
        <a class="action-button brand" href="/guide/getting-started">Docs</a>
        <a class="action-button alt" href="https://github.com/egonSchiele/agency-lang">GitHub</a>
      </div>
    </div>
    <div class="hero-right">
      <div class="code-block" v-html="codeHtml"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const codeHtml = ref('')

const code = `type Mood = "happy" | "sad"

node main() {
  const msg = input("How do you feel?")
  const prompt = "Please categorize the following message: \${msg}"
  const mood: Mood = llm(prompt)
  return mood
}`

onMounted(async () => {
  // Use VitePress's built-in Shiki instance for syntax highlighting
  const { createHighlighter } = await import('shiki')
  const highlighter = await createHighlighter({
    themes: ['dark-plus'],
    langs: ['typescript'],
  })
  codeHtml.value = highlighter.codeToHtml(code, {
    lang: 'typescript',
    theme: 'dark-plus',
  })
})
</script>

<style scoped>
.hero-with-code {
  display: flex;
  align-items: center;
  gap: 48px;
  max-width: 1152px;
  margin: 0 auto;
  padding: 96px 24px 64px;
}

.hero-left {
  flex: 1;
  min-width: 0;
}

.hero-right {
  flex: 2;
  min-width: 0;
}

.hero-name {
  font-size: 48px;
  font-weight: 700;
  line-height: 1.1;
  background: linear-gradient(135deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-tagline {
  font-size: 20px;
  color: var(--vp-c-text-2);
  margin-top: 12px;
}

.hero-actions {
  display: flex;
  gap: 12px;
  margin-top: 32px;
}

.action-button {
  display: inline-block;
  padding: 10px 24px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 0.2s;
}

.action-button.brand {
  background-color: var(--vp-c-brand-1);
  color: var(--vp-button-brand-text);
}

.action-button.brand:hover {
  background-color: var(--vp-c-brand-2);
}

.action-button.alt {
  background-color: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}

.action-button.alt:hover {
  background-color: var(--vp-c-default-3);
}

.hero-right :deep(pre) {
  border-radius: 8px;
  padding: 24px;
  font-size: 15px;
  line-height: 1.6;
  overflow-x: auto;
}

@media (max-width: 768px) {
  .hero-with-code {
    flex-direction: column;
    padding: 48px 24px 32px;
  }

  .hero-right {
    width: 100%;
  }
}
</style>
