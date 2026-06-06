<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { get } from '@/utils/request'

type AuditLog = {
  id: number
  request_id: string
  client_id: string | null
  user_identifier: string | null
  action_type: string | null
  action_name: string | null
  page_path: string | null
  page_title: string | null
  payload_preview: string | null
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  status_code: number
  decision: string
  reason: string
  duration_ms: number
  client_ip_hash: string
  user_agent: string | null
  created_at: string
}

const logs = ref<AuditLog[]>([])
const total = ref(0)
const limit = ref(20)
const offset = ref(0)
const isLoading = ref(false)
const filterClientId = ref('')
const filterDecision = ref('')

const fetchLogs = async () => {
  isLoading.value = true
  try {
    const data: any = await get('/admin/audit-logs', {
      limit: String(limit.value),
      offset: String(offset.value),
      clientId: filterClientId.value,
      decision: filterDecision.value
    })
    logs.value = data.logs
    total.value = data.total
  } catch (err) {
    console.error('Failed to fetch audit logs:', err)
  } finally {
    isLoading.value = false
  }
}

const nextPage = () => {
  if (offset.value + limit.value < total.value) {
    offset.value += limit.value
    fetchLogs()
  }
}

const prevPage = () => {
  if (offset.value >= limit.value) {
    offset.value -= limit.value
    fetchLogs()
  }
}

const resetAndFetch = () => {
  offset.value = 0
  fetchLogs()
}

onMounted(fetchLogs)

watch([filterClientId, filterDecision], () => {
  resetAndFetch()
})

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString()
}

const selectedLog = ref<AuditLog | null>(null)
const showModal = ref(false)

const openDetails = (log: AuditLog) => {
  selectedLog.value = log
  showModal.value = true
}
</script>

<template>
  <div class="max-w-7xl mx-auto p-4 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-900">AI 安全审计日志</h1>
      <div class="flex gap-2">
        <button 
          @click="fetchLogs" 
          class="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          :class="{ 'text-blue-600': isLoading }"
          :disabled="isLoading"
        >
          <div class="i-carbon-renew h-4 w-4" :class="{ 'animate-spin': isLoading }"></div>
          <span>刷新</span>
        </button>
      </div>
    </div>

    <!-- Filters -->
    <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-wrap gap-4 items-end">
      <div class="space-y-1">
        <label class="text-xs font-medium text-gray-500 uppercase tracking-wider">Client ID</label>
        <input 
          v-model="filterClientId" 
          placeholder="Filter by client..."
          class="block w-48 bg-gray-50 border-0 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 py-2 px-3"
        />
      </div>
      <div class="space-y-1">
        <label class="text-xs font-medium text-gray-500 uppercase tracking-wider">Decision</label>
        <select 
          v-model="filterDecision"
          class="block w-40 bg-gray-50 border-0 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 py-2 px-3"
        >
          <option value="">All Decisions</option>
          <option value="allow">Allow</option>
          <option value="reject">Reject</option>
        </select>
      </div>
      <div class="ml-auto text-sm text-gray-400">
        Showing {{ offset + 1 }} - {{ Math.min(offset + limit, total) }} of {{ total }}
      </div>
    </div>

    <!-- Table -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              <th class="px-6 py-4">时间</th>
              <th class="px-6 py-4">Client</th>
              <th class="px-6 py-4">Action</th>
              <th class="px-6 py-4">Status</th>
              <th class="px-6 py-4">Decision</th>
              <th class="px-6 py-4">Tokens</th>
              <th class="px-6 py-4">Latency</th>
              <th class="px-6 py-4"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50 text-sm">
            <tr v-if="logs.length === 0 && !isLoading">
              <td colspan="8" class="px-6 py-12 text-center text-gray-400">
                No audit logs found.
              </td>
            </tr>
            <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-6 py-4 whitespace-nowrap text-gray-600">
                {{ formatDate(log.created_at) }}
              </td>
              <td class="px-6 py-4">
                <span class="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{{ log.client_id || 'anonymous' }}</span>
              </td>
              <td class="px-6 py-4 text-gray-700">
                {{ log.action_name || log.action_type || '-' }}
              </td>
              <td class="px-6 py-4">
                <span 
                  class="px-2 py-1 rounded-full text-xs font-medium"
                  :class="log.status_code < 400 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'"
                >
                  {{ log.status_code }}
                </span>
              </td>
              <td class="px-6 py-4">
                <span 
                  class="px-2 py-1 rounded-full text-xs font-medium"
                  :class="log.decision === 'allow' ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'"
                >
                  {{ log.decision.toUpperCase() }}
                </span>
              </td>
              <td class="px-6 py-4 font-mono text-xs">
                {{ log.total_tokens }}
              </td>
              <td class="px-6 py-4 text-gray-500">
                {{ log.duration_ms }}ms
              </td>
              <td class="px-6 py-4 text-right">
                <button 
                  @click="openDetails(log)"
                  class="text-blue-600 hover:text-blue-800 font-medium"
                >
                  Details
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
        <button 
          @click="prevPage" 
          :disabled="offset === 0"
          class="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <button 
          @click="nextPage" 
          :disabled="offset + limit >= total"
          class="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>

    <!-- Modal -->
    <div v-if="showModal && selectedLog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-gray-900/50 backdrop-blur-sm" @click="showModal = false"></div>
      <div class="relative bg-white w-full max-w-2xl rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 class="text-lg font-bold text-gray-900">Interaction Details</h2>
          <button @click="showModal = false" class="text-gray-400 hover:text-gray-600">
            <div class="i-carbon-close h-6 w-6"></div>
          </button>
        </div>
        <div class="p-6 overflow-y-auto space-y-6">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-medium text-gray-400 uppercase">Request ID</label>
              <p class="font-mono text-sm">{{ selectedLog.request_id }}</p>
            </div>
            <div>
              <label class="text-xs font-medium text-gray-400 uppercase">Fingerprint (IP Hash)</label>
              <p class="font-mono text-sm truncate">{{ selectedLog.client_ip_hash }}</p>
            </div>
            <div>
              <label class="text-xs font-medium text-gray-400 uppercase">Path</label>
              <p class="text-sm font-medium">{{ selectedLog.page_path }}</p>
            </div>
            <div>
              <label class="text-xs font-medium text-gray-400 uppercase">Reason</label>
              <p class="text-sm text-red-600">{{ selectedLog.reason || '-' }}</p>
            </div>
          </div>

          <div>
            <label class="text-xs font-medium text-gray-400 uppercase">User Agent</label>
            <p class="text-xs bg-gray-50 p-2 rounded mt-1 overflow-x-auto">{{ selectedLog.user_agent }}</p>
          </div>

          <div>
            <label class="text-xs font-medium text-gray-400 uppercase">Payload Preview</label>
            <pre class="text-xs bg-gray-900 text-gray-300 p-4 rounded-xl mt-1 overflow-x-auto">{{ selectedLog.payload_preview || '(No preview available)' }}</pre>
          </div>
        </div>
        <div class="px-6 py-4 bg-gray-50 text-right">
          <button 
            @click="showModal = false"
            class="px-6 py-2 bg-white border border-gray-200 rounded-lg text-sm font-bold hover:bg-gray-100 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Glassmorphism and premium effects can be added here if needed */
</style>
