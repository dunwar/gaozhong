<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 标题 + AI 指导按钮 -->
    <div class="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">📊 知识点汇总</h1>
        <p class="text-gray-500 text-sm mt-1">薄弱点分析，精准定位需要巩固的知识点</p>
      </div>
      <button
        @click="showGuidanceModal = true; generateGuidance()"
        :disabled="generatingGuidance"
        class="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white px-5 py-3 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all font-medium shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg v-if="generatingGuidance" class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path>
        </svg>
        {{ generatingGuidance ? 'AI 分析中...' : '✨ AI 学习指导' }}
      </button>
    </div>

    <!-- AI 指导 Modal -->
    <div v-if="showGuidanceModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" @click.self="showGuidanceModal = false">
      <div class="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto">
        <div class="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <h2 class="text-xl font-bold text-gray-900">🧠 AI 学习指导</h2>
            <select
              v-model="guidanceSubject"
              :disabled="generatingGuidance"
              class="ml-2 px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-medium bg-white focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <option v-for="s in guidanceSubjects" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </div>
          <button @click="showGuidanceModal = false" class="text-gray-400 hover:text-gray-600 text-2xl">×</button>
        </div>
        <div class="p-6">
          <!-- 加载中 -->
          <div v-if="generatingGuidance" class="text-center py-12">
            <div class="inline-block w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p class="text-gray-700 font-medium">AI 正在分析你的学习状况...</p>
            <p class="text-gray-500 text-sm mt-1">这可能需要 1-2 分钟</p>
          </div>

          <!-- 错误 -->
          <div v-else-if="guidanceError" class="text-center py-12">
            <div class="text-5xl mb-4">😕</div>
            <p class="text-gray-700 font-medium">{{ guidanceError }}</p>
            <button @click="generateGuidance" class="mt-4 text-blue-600 hover:text-blue-700 font-medium">重试</button>
          </div>

          <!-- 结果 -->
          <div v-else-if="guidanceResult" class="space-y-6">
            <!-- 整体评估 -->
            <div class="bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl p-5">
              <h3 class="font-semibold text-gray-900 mb-2">📊 整体评估：{{ guidanceResult.overallAssessment?.level || '分析中' }}</h3>
              <p class="text-gray-700">{{ guidanceResult.overallAssessment?.summary }}</p>
              <div class="flex flex-wrap gap-2 mt-3">
                <span v-for="(finding, i) in guidanceResult.overallAssessment?.keyFindings || []" :key="i" class="px-2 py-1 bg-white rounded text-xs text-gray-600">{{ finding }}</span>
              </div>
            </div>

            <!-- 薄弱点分析 -->
            <div v-if="guidanceResult.weaknessAnalysis?.length">
              <h3 class="font-semibold text-gray-900 mb-3">🔍 薄弱知识模块</h3>
              <div class="space-y-2">
                <div v-for="(w, i) in guidanceResult.weaknessAnalysis" :key="i" class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <span class="w-6 h-6 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs font-bold">{{ i + 1 }}</span>
                  <div class="flex-1">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-gray-800">{{ w.knowledgeArea }}</span>
                      <span :class="w.severity === '高' ? 'bg-red-50 text-red-700' : w.severity === '中' ? 'bg-yellow-50 text-yellow-700' : 'bg-green-50 text-green-700'" class="px-2 py-0.5 rounded text-xs">{{ w.severity }}</span>
                    </div>
                    <p class="text-sm text-gray-500 mt-0.5">{{ w.typicalErrors }}</p>
                  </div>
                  <span class="text-sm text-gray-400">{{ w.errorCount }} 题</span>
                </div>
              </div>
            </div>

            <!-- 学习计划 -->
            <div v-if="guidanceResult.studyPlan">
              <h3 class="font-semibold text-gray-900 mb-3">📋 学习建议</h3>
              <div class="space-y-4">
                <div class="bg-green-50 rounded-lg p-4">
                  <h4 class="font-medium text-green-800 mb-2">本周行动</h4>
                  <ul class="list-disc list-inside text-sm text-green-700 space-y-1">
                    <li v-for="(a, i) in guidanceResult.studyPlan.immediateActions" :key="i">{{ a }}</li>
                  </ul>
                </div>
                <div class="bg-blue-50 rounded-lg p-4">
                  <h4 class="font-medium text-blue-800 mb-2">1-2 周目标</h4>
                  <ul class="list-disc list-inside text-sm text-blue-700 space-y-1">
                    <li v-for="(g, i) in guidanceResult.studyPlan.shortTermGoals" :key="i">{{ g }}</li>
                  </ul>
                </div>
              </div>
            </div>

            <!-- 考试策略 -->
            <div v-if="guidanceResult.examStrategy">
              <h3 class="font-semibold text-gray-900 mb-3">📝 考试策略</h3>
              <div class="bg-orange-50 rounded-lg p-4 space-y-3">
                <p class="text-sm text-orange-800"><strong>时间分配：</strong>{{ guidanceResult.examStrategy.timeManagement }}</p>
                <div>
                  <strong class="text-sm text-orange-800">常见陷阱：</strong>
                  <ul class="list-disc list-inside text-sm text-orange-700 mt-1 space-y-0.5">
                    <li v-for="(p, i) in guidanceResult.examStrategy.commonPitfalls" :key="i">{{ p }}</li>
                  </ul>
                </div>
              </div>
            </div>

            <!-- 鼓励语 -->
            <div v-if="guidanceResult.encouragement" class="bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg p-4 text-center">
              <p class="text-gray-700 italic">{{ guidanceResult.encouragement }}</p>
            </div>
          </div>
        </div>
      </div>
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
            <span :class="subBadge(subject)" class="w-14 text-center px-2 py-1 rounded text-xs font-semibold flex-shrink-0">{{ subject }}</span>
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
            <span :class="errBadge(type)" class="px-2 py-0.5 rounded-full text-xs font-medium">{{ type }}</span>
            <span class="text-lg font-bold" :class="errorTypeTextColorClass(type)">{{ count }}</span>
            <span class="text-xs text-gray-400">次</span>
          </div>
        </div>
      </div>

      <!-- 最近试卷 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-8">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold text-gray-900">📄 最近试卷</h2>
          <router-link to="/errors?view=paper" class="text-sm text-blue-600 hover:text-blue-700">查看全部 →</router-link>
        </div>
        <div v-if="paperSessions.length === 0" class="text-gray-400 text-sm text-center py-6">
          还没有上传过试卷，<router-link to="/error-upload" class="text-blue-600 hover:text-blue-700">去上传第一份 →</router-link>
        </div>
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <div
            v-for="s in paperSessions"
            :key="s.id"
            @click="goToPaperErrors(s)"
            class="p-4 bg-gray-50 rounded-xl hover:bg-blue-50 transition-colors cursor-pointer border border-transparent hover:border-blue-200"
          >
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span :class="subBadge(s.subject)" class="px-2 py-1 rounded text-xs font-semibold">{{ s.subject }}</span>
                <span class="text-sm font-medium text-gray-800 truncate max-w-[150px]">{{ s.title || '未命名试卷' }}</span>
              </div>
              <span :class="s.status==='done'?'text-green-600':'text-yellow-600'" class="text-xs">
                {{ s.status === 'done' ? '✅ 已完成' : s.status === 'failed' ? '❌ 失败' : '🔄 处理中' }}
              </span>
            </div>
            <div class="flex items-center gap-4 text-xs text-gray-500">
              <span>{{ s.imageCount || 1 }} 页</span>
              <span v-if="s.totalQuestions">{{ s.totalQuestions }} 题</span>
              <span v-if="s.correctCount != null">对 {{ s.correctCount }}</span>
              <span>{{ s.createdAt?.substring(0, 10) || '' }}</span>
            </div>
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
            class="flex items-center gap-3 p-3 rounded-xl transition-colors cursor-pointer" :class="kp.errorCount>=3?'hover:bg-red-50':kp.errorCount>=2?'hover:bg-orange-50':'hover:bg-blue-50'" @click="showKpErrors(kp)"
          >
            <!-- 排名 -->
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
              :class="rankClass(i)"
            >{{ i + 1 }}</div>

            <!-- 信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span :class="subBadge(kp.subject)" class="px-2 py-0.5 rounded text-xs font-medium flex-shrink-0">{{ kp.subject }}</span>
                <span class="text-sm font-medium text-gray-800 truncate">{{ kp.name }}</span>
                <span v-if="kp.errorCount >= 3" class="text-xs" title="高频薄弱点">🔥</span>
                <span v-else-if="kp.errorCount >= 2" class="text-xs" title="需关注">⚠️</span>
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

      <!-- 知识点下钻弹窗 -->
      <div v-if="kpModal.visible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" @click.self="kpModal.visible = false">
        <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
          <div class="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <div><h3 class="text-lg font-bold text-gray-900">{{ kpModal.kp?.name }}</h3><p class="text-xs text-gray-500">{{ kpModal.kp?.subject }} · {{ kpModal.kp?.category }} · {{ kpModal.errors?.length || 0 }} 道相关错题</p></div>
            <button @click="kpModal.visible = false" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
          </div>
          <div class="p-4 space-y-3">
            <div v-if="kpModal.loading" class="text-center py-8"><div class="inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>
            <div v-else-if="kpModal.errors.length === 0" class="text-center py-8 text-gray-400">暂无关联错题</div>
            <div v-for="err in kpModal.errors" :key="err.id" @click="$router.push('/error/'+err.id)" class="p-4 bg-gray-50 rounded-xl hover:bg-blue-50 transition-colors cursor-pointer">
              <div class="flex items-center gap-2 mb-2"><span :class="subBadge(err.subject)" class="px-2 py-0.5 rounded text-xs font-medium">{{ err.subject }}</span><span v-if="err.topic" class="text-xs text-gray-400">{{ err.topic }}</span></div>
              <p class="text-sm text-gray-800 line-clamp-2">{{ err.questionText }}</p>
              <div class="flex items-center gap-2 mt-2"><span v-if="err.errorType" :class="errBadge(err.errorType)" class="px-2 py-0.5 rounded-full text-xs font-medium">{{ err.errorType }}</span><span class="text-xs text-gray-400">&starf;{{ err.difficulty || 3 }}</span></div>
            </div>
          </div>
        </div>
      </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { authFetch } from '../utils/authStore.js'

const errorStats = ref({ total: 0, bySubject: {}, byErrorType: {}, todayCount: 0 })
const knowledgeStats = ref([])
const paperSessions = ref([])
const kpModal = reactive({ visible: false, loading: false, kp: null, errors: [] })
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

function subBadge(s){const m={"数学":"bg-blue-50 text-blue-700","物理":"bg-purple-50 text-purple-700","化学":"bg-green-50 text-green-700","生物":"bg-teal-50 text-teal-700","英语":"bg-orange-50 text-orange-700","语文":"bg-red-50 text-red-700"};return m[s]||"bg-gray-50 text-gray-600"}
function errBadge(t){const m={"概念不清":"bg-red-50 text-red-700","计算失误":"bg-yellow-50 text-yellow-700","审题偏差":"bg-purple-50 text-purple-700","方法错误":"bg-orange-50 text-orange-700","粗心马虎":"bg-blue-50 text-blue-700","知识盲区":"bg-gray-100 text-gray-700"};return m[t]||"bg-gray-50 text-gray-600"}
function kpCountColor(n){return n>=3?"text-red-600":n>=2?"text-orange-500":"text-blue-500"}
async function showKpErrors(kp){kpModal.visible=true;kpModal.kp=kp;kpModal.loading=true;kpModal.errors=[];try{const r=await authFetch("/api/knowledge/errors?kpId="+kp.id);const d=await r.json();if(d.success)kpModal.errors=d.errors||[]}catch(e){console.error(e)}finally{kpModal.loading=false}}

async function loadSessions() {
  try {
    const res = await authFetch('/api/paper/sessions?limit=6')
    const data = await res.json()
    if (data.success) paperSessions.value = data.sessions || []
  } catch (e) { console.error('加载试卷列表失败:', e) }
}

function goToPaperErrors(session) {
  window.location.href = `/errors?sessionId=${session.id}&view=paper`
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

// ========== AI 学习指导 ==========

const showGuidanceModal = ref(false)
const generatingGuidance = ref(false)
const guidanceError = ref('')
const guidanceResult = ref(null)
const guidanceSubject = ref('数学')

const guidanceSubjects = [
  { value: '数学', label: '📐 数学' }, { value: '物理', label: '⚡ 物理' },
  { value: '化学', label: '🧪 化学' }, { value: '生物', label: '🧬 生物' },
  { value: '英语', label: '🌍 英语' }, { value: '语文', label: '📖 语文' }
]

async function generateGuidance() {
  if (generatingGuidance.value) return
  generatingGuidance.value = true
  guidanceError.value = ''
  guidanceResult.value = null

  try {
    const res = await authFetch('/api/paper/guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: guidanceSubject.value, timeRange: '本学期开始至今' })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || '请求失败')
    }

    const data = await res.json()

    // 轮询直到完成
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const poll = await authFetch(`/api/paper/guidance/${data.taskId}`)
      if (!poll.ok) continue
      const pollData = await poll.json()
      if (pollData.status === 'done') {
        guidanceResult.value = pollData.result
        generatingGuidance.value = false
        return
      } else if (pollData.status === 'failed') {
        throw new Error(pollData.error || '分析失败')
      }
    }
    throw new Error('分析超时')
  } catch (err) {
    guidanceError.value = err.message || '生成学习指导失败'
    generatingGuidance.value = false
  }
}

onMounted(() => { loadStats(); loadSessions(); })
</script>
