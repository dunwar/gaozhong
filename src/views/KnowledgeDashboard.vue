<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 标题 -->
    <div class="mb-8">
      <h1 class="text-2xl font-bold text-gray-900">📊 知识点汇总</h1>
      <p class="text-gray-500 text-sm mt-1">薄弱点分析，精准定位需要巩固的知识点</p>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <!-- 数据为空 -->
    <div v-else-if="isEmpty" class="text-center py-16">
      <div class="text-5xl mb-4">📝</div>
      <p class="text-gray-500 mb-4">还没有错题数据，无法进行分析</p>
      <router-link to="/error-upload" class="text-blue-600 hover:text-blue-700 font-medium text-sm">去录入第一道错题 →</router-link>
    </div>

    <!-- 仪表盘内容 -->
    <template v-else>
      <!-- 概览卡片 -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <div class="text-2xl font-bold text-blue-600">{{ errorStats.total }}</div>
          <div class="text-xs text-gray-500 mt-1">错题总数</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <div class="text-2xl font-bold text-green-600">{{ knowledgeStats.length }}</div>
          <div class="text-xs text-gray-500 mt-1">涉及知识点</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <div class="text-2xl font-bold text-orange-600">{{ weakPoints.length }}</div>
          <div class="text-xs text-gray-500 mt-1">薄弱点(≥2题)</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <div class="text-2xl font-bold text-purple-600">{{ errorStats.todayCount }}</div>
          <div class="text-xs text-gray-500 mt-1">今日新增</div>
        </div>
      </div>

      <!-- 学科分布 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-8">
        <h2 class="text-lg font-semibold text-gray-900 mb-4">📊 学科分布</h2>
        <div v-if="Object.keys(errorStats.bySubject).length === 0" class="text-gray-400 text-sm text-center py-4">
          暂无数据
        </div>
        <div v-else class="space-y-3">
          <div v-for="(count, subject) in errorStats.bySubject" :key="subject" class="flex items-center gap-3">
            <span :class="subjectBadgeClass(subject)" class="w-14 text-center px-2 py-1 rounded text-xs font-semibold flex-shrink-0">{{ subject }}</span>
            <div class="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
              <div
                :class="subjectBarClass(subject)"
                class="h-full rounded-full transition-all duration-500"
                :style="{ width: barWidth(count, maxErrorCount) + '%' }"
              ></div>
            </div>
            <span class="text-sm text-gray-600 w-8 text-right flex-shrink-0">{{ count }}</span>
          </div>
        </div>
      </div>

      <!-- 错误类型分布 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-8">
        <h2 class="text-lg font-semibold text-gray-900 mb-4">🔍 错误类型分布</h2>
        <div v-if="Object.keys(errorStats.byErrorType).length === 0" class="text-gray-400 text-sm text-center py-4">
          暂无数据
        </div>
        <div v-else class="flex flex-wrap gap-3">
          <div
            v-for="(count, type) in errorStats.byErrorType"
            :key="type"
            class="flex items-center gap-2 px-3 py-2 rounded-xl border"
            :class="errorTypeBorderClass(type)"
          >
            <span :class="errorTypeTagClass(type)" class="px-2 py-0.5 rounded-full text-xs font-medium">{{ type }}</span>
            <span class="text-lg font-bold" :class="errorTypeTextColorClass(type)">{{ count }}</span>
            <span class="text-xs text-gray-400">次</span>
          </div>
        </div>
      </div>

      <!-- 薄弱知识点 Top 榜 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold text-gray-900">⚠️ 薄弱知识点 Top {{ knowledgeStats.length }}</h2>
          <span class="text-xs text-gray-400">按错题数降序</span>
        </div>
        <div v-if="knowledgeStats.length === 0" class="text-gray-400 text-sm text-center py-4">
          暂无知识点数据
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="(kp, i) in knowledgeStats"
            :key="kp.id"
            class="flex items-center gap-3 p-3 rounded-xl transition-colors hover:bg-gray-50"
          >
            <!-- 排名 -->
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
              :class="rankClass(i)"
            >{{ i + 1 }}</div>

            <!-- 信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span :class="subjectBadgeClass(kp.subject)" class="px-2 py-0.5 rounded text-xs font-medium flex-shrink-0">{{ kp.subject }}</span>
                <span class="text-sm font-medium text-gray-800 truncate">{{ kp.name }}</span>
              </div>
              <div v-if="kp.category" class="text-xs text-gray-400 mt-0.5">{{ kp.category }}</div>
            </div>

            <!-- 进度条 -->
            <div class="w-24 sm:w-32 flex items-center gap-2 flex-shrink-0">
              <div class="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-500"
                  :class="rankBarClass(i)"
                  :style="{ width: barWidth(kp.errorCount, maxKpCount) + '%' }"
                ></div>
              </div>
              <span class="text-sm font-semibold text-gray-600 w-6 text-right">{{ kp.errorCount }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { authFetch } from '../utils/authStore.js'

const errorStats = ref({ total: 0, bySubject: {}, byErrorType: {}, todayCount: 0 })
const knowledgeStats = ref([])
const loading = ref(true)

const maxErrorCount = computed(() => {
  const vals = Object.values(errorStats.value.bySubject || {})
  return Math.max(1, ...vals)
})

const maxKpCount = computed(() => {
  if (!knowledgeStats.value.length) return 1
  return Math.max(1, ...knowledgeStats.value.map(k => k.errorCount))
})

const isEmpty = computed(() => errorStats.value.total === 0)

const weakPoints = computed(() => knowledgeStats.value.filter(k => k.errorCount >= 2))

function barWidth(count, max) {
  return Math.round((count / max) * 100) || 0
}

function subjectBadgeClass(subject) {
  const map = {
    '数学': 'bg-blue-50 text-blue-700',
    '物理': 'bg-purple-50 text-purple-700',
    '化学': 'bg-green-50 text-green-700',
    '英语': 'bg-orange-50 text-orange-700',
    '语文': 'bg-red-50 text-red-700',
  }
  return map[subject] || 'bg-gray-50 text-gray-600'
}

function subjectBarClass(subject) {
  const map = {
    '数学': 'bg-blue-500',
    '物理': 'bg-purple-500',
    '化学': 'bg-green-500',
    '英语': 'bg-orange-500',
    '语文': 'bg-red-500',
  }
  return map[subject] || 'bg-gray-400'
}

function errorTypeTagClass(type) {
  const map = {
    '概念不清': 'bg-red-50 text-red-700',
    '计算失误': 'bg-yellow-50 text-yellow-700',
    '审题偏差': 'bg-purple-50 text-purple-700',
    '方法错误': 'bg-orange-50 text-orange-700',
    '粗心': 'bg-blue-50 text-blue-700',
    '知识盲区': 'bg-gray-100 text-gray-700',
  }
  return map[type] || 'bg-gray-50 text-gray-600'
}

function errorTypeBorderClass(type) {
  const map = {
    '概念不清': 'border-red-200 bg-red-50/30',
    '计算失误': 'border-yellow-200 bg-yellow-50/30',
    '审题偏差': 'border-purple-200 bg-purple-50/30',
    '方法错误': 'border-orange-200 bg-orange-50/30',
    '粗心': 'border-blue-200 bg-blue-50/30',
    '知识盲区': 'border-gray-200 bg-gray-50/30',
  }
  return map[type] || 'border-gray-200 bg-gray-50'
}

function errorTypeTextColorClass(type) {
  const map = {
    '概念不清': 'text-red-600',
    '计算失误': 'text-yellow-600',
    '审题偏差': 'text-purple-600',
    '方法错误': 'text-orange-600',
    '粗心': 'text-blue-600',
    '知识盲区': 'text-gray-600',
  }
  return map[type] || 'text-gray-600'
}

function rankClass(i) {
  if (i === 0) return 'bg-red-100 text-red-700'
  if (i === 1) return 'bg-orange-100 text-orange-700'
  if (i === 2) return 'bg-yellow-100 text-yellow-700'
  return 'bg-gray-100 text-gray-500'
}

function rankBarClass(i) {
  if (i === 0) return 'bg-red-500'
  if (i === 1) return 'bg-orange-500'
  if (i === 2) return 'bg-yellow-500'
  return 'bg-blue-400'
}

async function loadStats() {
  loading.value = true
  try {
    const [statsRes, kpRes] = await Promise.all([
      authFetch('/api/error/stats'),
      authFetch('/api/knowledge/stats')
    ])
    const statsData = await statsRes.json()
    const kpData = await kpRes.json()
    if (statsData.success) {
      errorStats.value = {
        total: statsData.total || 0,
        bySubject: statsData.bySubject || {},
        byErrorType: statsData.byErrorType || {},
        todayCount: statsData.todayCount || 0
      }
    }
    if (kpData.success) {
      knowledgeStats.value = kpData.stats || []
    }
  } catch (err) {
    console.error('加载统计数据失败:', err)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadStats())
</script>
