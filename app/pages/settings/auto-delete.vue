<script setup lang="ts">
interface AutoDeleteCounts { evaluated: number, deleted: number, failed: number, skippedUnderThreshold: number }

const toast = useToast()
const { data, refresh } = await useFetch('/api/settings/auto-delete', { key: 'auto-delete' })

const form = reactive({ enabled: false, thresholdPercent: 75, maxDeletesPerRun: 5 })
watchEffect(() => {
  if (data.value) {
    form.enabled = data.value.enabled
    form.thresholdPercent = data.value.thresholdPercent
    form.maxDeletesPerRun = data.value.maxDeletesPerRun
  }
})

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings/auto-delete', { method: 'PUT', body: { ...form } })
    toast.add({ title: 'Auto-delete settings saved', color: 'success', icon: 'i-lucide-check' })
    await refresh()
  } catch (e) {
    toast.add({ title: 'Save failed', description: (e as Error).message, color: 'error' })
  } finally {
    saving.value = false
  }
}

const running = ref(false)
async function runNow() {
  running.value = true
  try {
    const res = await $fetch<{ ok: boolean, counts: AutoDeleteCounts }>('/api/reaping/auto-delete-run', { method: 'POST' })
    const c = res.counts
    toast.add({
      title: 'Auto-delete pass complete',
      description: `Evaluated ${c.evaluated}, deleted ${c.deleted}, failed ${c.failed}, ${c.skippedUnderThreshold} source(s) under threshold.`,
      color: c.failed > 0 ? 'warning' : 'success',
      icon: 'i-lucide-play'
    })
  } catch (e) {
    toast.add({ title: 'Run failed', description: (e as Error).message, color: 'error' })
  } finally {
    running.value = false
  }
}

const regenerating = ref(false)
async function regenerateKey() {
  regenerating.value = true
  try {
    await $fetch('/api/settings/regenerate-api-key', { method: 'POST' })
    toast.add({ title: 'API key regenerated', description: 'The old key stops working immediately.', color: 'success', icon: 'i-lucide-refresh-cw' })
    await refresh()
  } catch (e) {
    toast.add({ title: 'Regenerate failed', description: (e as Error).message, color: 'error' })
  } finally {
    regenerating.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 space-y-6 max-w-2xl">
    <div class="flex items-center justify-between">
      <div class="space-y-1">
        <h1 class="text-2xl font-bold">
          Auto-delete
        </h1>
        <p class="text-muted text-sm">
          When a title is due and the media pool crosses this threshold, delete its file via
          Sonarr/Radarr instead of waiting for a manual mark-removed. Ships off by default.
        </p>
      </div>
      <div class="flex gap-2">
        <UButton
          to="/settings/connections"
          color="neutral"
          variant="ghost"
          icon="i-lucide-plug"
        >
          Connections
        </UButton>
        <UButton
          to="/settings/scoring"
          color="neutral"
          variant="ghost"
          icon="i-lucide-sliders-horizontal"
        >
          Scoring
        </UButton>
        <UButton
          to="/settings/notifications"
          color="neutral"
          variant="ghost"
          icon="i-lucide-mail"
        >
          Notifications
        </UButton>
      </div>
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <span class="font-semibold">Disk threshold</span>
          <USwitch
            v-model="form.enabled"
            :label="form.enabled ? 'Enabled' : 'Disabled'"
          />
        </div>
      </template>
      <div class="space-y-4">
        <UFormField
          label="Threshold (% used)"
          help="Runs hourly; due titles are only deleted once the relevant *arr's media pool is at or above this."
        >
          <UInput
            v-model.number="form.thresholdPercent"
            type="number"
            class="w-40"
          />
        </UFormField>
        <UFormField
          label="Max deletes per run"
          help="0 = unlimited. Neither Janitorr nor Maintainerr enforce a cap here — this does."
        >
          <UInput
            v-model.number="form.maxDeletesPerRun"
            type="number"
            class="w-40"
          />
        </UFormField>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <span class="font-semibold">API access</span>
      </template>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          Requests from a local/private address (matching Sonarr/Radarr's own "local addresses"
          model) never need this — it's only checked for the destructive auto-delete endpoints, and
          only when the request comes from outside your LAN.
        </p>
        <UFormField label="API key">
          <div class="flex gap-2">
            <UInput
              :model-value="data?.apiKey ?? ''"
              readonly
              class="w-full font-mono"
            />
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-refresh-cw"
              :loading="regenerating"
              @click="regenerateKey"
            >
              Regenerate
            </UButton>
          </div>
        </UFormField>
      </div>
    </UCard>

    <div class="flex justify-end gap-2">
      <UButton
        color="neutral"
        variant="subtle"
        icon="i-lucide-play"
        :loading="running"
        @click="runNow"
      >
        Run now
      </UButton>
      <UButton
        color="primary"
        icon="i-lucide-save"
        :loading="saving"
        @click="save"
      >
        Save
      </UButton>
    </div>
  </UContainer>
</template>
