<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">📒 我的错题本</h1>
        <p class="text-gray-500 text-sm mt-1" v-if="totalCount > 0">共 {{ totalCount }} 道错题</p>
        <div v-if="drillContext" class="mt-2 flex items-center gap-2">
          <button @click="clearDrill" class="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
            返回全部
          </button>
          <span class="text-gray-400">|</span>
          <span class="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-medium">{{ drillContext }}</span>
        </div>
      </div>
      <router-link to="/error-upload" class="mt-3 sm:mt-0 inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">+ 上传试卷</router-link>
    </div>

    <!-- 视图切换 -->
    <div class="flex flex-wrap gap-2 mb-6 border-b border-gray-200 pb-3">
      <button v-for="v in views" :key="v.value" @click="switchView(v.value)" :class="currentView === v.value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'" class="px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5">
        <span>{{ v.icon }}</span>{{ v.label }}
      </button>
    </div>

    <div v-if="loading" class="text-center py-16"><div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div><p class="text-gray-500 text-sm mt-3">加载中...</p></div>

    <!-- 按试卷 -->
    <div v-if="currentView === 'paper'" class="space-y-4">
      <div v-if="papers.length === 0" class="text-center py-16"><div class="text-5xl mb-4">📄</div><p class="text-gray-500 mb-4">还没有上传过试卷</p><router-link to="/error-upload" class="text-blue-600 hover:text-blue-700 font-medium">去上传第一份试卷 →</router-link></div>
      <div v-for="paper in papers" :key="paper.id" @click="goPaperDetail(paper)" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer">
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-2">
              <span :class="subBadge(paper.subject)" class="px-2 py-0.5 rounded text-xs font-medium">{{ paper.subject }}</span>
              <span class="text-sm text-gray-500">{{ fmtTime(paper.createdAt) }}</span>
            </div>
            <h3 class="text-gray-800 font-medium mb-1">{{ paper.title || '未命名试卷' }}</h3>
            <div class="flex items-center gap-4 text-sm text-gray-500 mt-2">
              <span>📝 {{ paper.error_count || 0 }} 道错题</span>
              <span>📷 {{ paper.image_count || 1 }} 张图片</span>
            </div>
          </div>
          <svg class="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
        </div>
      </div>
      <div v-if="paperTotalPages > 1" class="flex items-center justify-center gap-2 mt-8">
        <button @click="paperPage--" :disabled="paperPage <= 1" class="px-3 py-2 text-sm rounded-lg border disabled:opacity-40 hover:bg-gray-50">上一页</button>
        <span class="text-sm text-gray-500">{{ paperPage }} / {{ paperTotalPages }}</span>
        <button @click="paperPage++" :disabled="paperPage >= paperTotalPages" class="px-3 py-2 text-sm rounded-lg border disabled:opacity-40 hover:bg-gray-50">下一页</button>
      </div>
    </div>

    <!-- 按时间 -->
    <div v-if="currentView === 'time'" class="space-y-4">
      <div v-if="timeGroups.length === 0" class="text-center py-16"><div class="text-5xl mb-4">📅</div><p class="text-gray-500">还没有错题数据</p></div>
      <div v-for="g in timeGroups" :key="g.timeLabel" @click="goTimeDetail(g)" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-lg font-semibold text-gray-800">{{ g.timeLabel }}</h3>
          <div class="flex items-center gap-3"><span class="text-sm text-gray-500">{{ g.errorCount }} 道错题 · {{ g.paperCount }} 份</span><svg class="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg></div>
        </div>
        <span class="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs">{{ g.subjectCount }} 个科目</span>
      </div>
    </div>

    <!-- 按科目 -->
    <div v-if="currentView === 'subject'" class="space-y-4">
      <div v-if="subjectGroups.length === 0" class="text-center py-16"><div class="text-5xl mb-4">📚</div><p class="text-gray-500">还没有错题数据</p></div>
      <div v-for="g in subjectGroups" :key="g.subject" @click="goSubjectDetail(g)" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2"><span :class="subBadge(g.subject)" class="px-3 py-1 rounded-lg text-sm font-medium">{{ g.subject }}</span><span class="text-sm text-gray-500">{{ g.paperCount }} 份</span></div>
          <div class="flex items-center gap-3"><span class="text-lg font-bold text-blue-600">{{ g.errorCount }} <span class="text-sm text-gray-400 font-normal">题</span></span><svg class="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <span v-for="(t,i) in (g.errorTypes||[]).slice(0,5)" :key="i" :class="errBadge(t)" class="px-2 py-0.5 rounded-full text-xs">{{ t }}</span>
          <span v-if="(g.errorTypes||[]).length > 5" class="text-xs text-gray-400">+{{ g.errorTypes.length - 5 }}</span>
        </div>
      </div>
    </div>

    <!-- 列表（含下钻） -->
    <div v-if="currentView === 'list'" class="space-y-3">
      <div class="flex flex-wrap gap-2 mb-4">
        <button @click="filterSubject='';fetchList()" :class="!filterSubject?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'" class="px-4 py-2 rounded-lg text-sm font-medium">全部</button>
        <button v-for="s in subjects" :key="s.value" @click="filterSubject=s.value;fetchList()" :class="filterSubject===s.value?s.activeClass:'bg-gray-100 text-gray-600 hover:bg-gray-200'" class="px-4 py-2 rounded-lg text-sm font-medium">{{ s.label }}</button>
      </div>

      <div v-if="records.length === 0" class="text-center py-16"><div class="text-5xl mb-4">📝</div><p class="text-gray-500 mb-4">还没有错题记录</p><router-link to="/error-upload" class="text-blue-600 hover:text-blue-700 font-medium">去录入第一道错题 →</router-link></div>

      <div v-else class="space-y-3">
        <div v-for="err in records" :key="err.id" @click="router.push('/error/'+err.id)" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer group">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-2"><span :class="subBadge(err.subject)" class="px-2 py-0.5 rounded text-xs font-medium">{{ err.subject }}</span><span v-if="err.topic" class="text-xs text-gray-400">{{ err.topic }}</span></div>
              <p class="text-gray-800 text-sm font-medium line-clamp-2 mb-2 group-hover:text-blue-700 transition-colors">{{ err.questionText }}</p>
              <div class="flex flex-wrap items-center gap-3 text-xs">
                <span v-if="err.errorType" :class="errBadge(err.errorType)" class="px-2 py-0.5 rounded-full font-medium">{{ err.errorType }}</span>
                <span class="flex items-center gap-0.5 text-gray-400"><span v-for="i in 5" :key="i" :class="i<=err.difficulty?'text-yellow-500':'text-gray-200'" class="text-xs">★</span></span>
                <span class="text-gray-400">{{ fmtTime(err.createdAt) }}</span>
              </div>
            </div>
            <svg class="w-5 h-5 text-gray-300 group-hover:text-blue-500 flex-shrink-0 mt-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
          </div>
        </div>
      </div>

      <div v-if="listTotalPages > 1" class="flex items-center justify-center gap-2 mt-8">
        <button @click="listPage--" :disabled="listPage<=1" class="px-3 py-2 text-sm rounded-lg border disabled:opacity-40 hover:bg-gray-50">上一页</button>
        <span class="text-sm text-gray-500">{{ listPage }} / {{ listTotalPages }}</span>
        <button @click="listPage++" :disabled="listPage>=listTotalPages" class="px-3 py-2 text-sm rounded-lg border disabled:opacity-40 hover:bg-gray-50">下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'
const router = useRouter()

const views = [{ value: 'paper', icon: '📄', label: '按试卷' },{ value: 'time', icon: '📅', label: '按时间' },{ value: 'subject', icon: '📚', label: '按科目' },{ value: 'list', icon: '📝', label: '列表' }]
const subjects = [{ value: '数学', label: '📐 数学', activeClass: 'bg-blue-600 text-white' },{ value: '物理', label: '⚡ 物理', activeClass: 'bg-purple-600 text-white' },{ value: '化学', label: '🧪 化学', activeClass: 'bg-green-600 text-white' },{ value: '生物', label: '🧬 生物', activeClass: 'bg-teal-600 text-white' },{ value: '英语', label: '🌍 英语', activeClass: 'bg-orange-600 text-white' },{ value: '语文', label: '📖 语文', activeClass: 'bg-red-600 text-white' }]

const currentView = ref('paper'), loading = ref(false)
const papers = ref([]), paperPage = ref(1), paperTotalPages = ref(0)
const timeGroups = ref([]), subjectGroups = ref([])
const records = ref([]), filterSubject = ref(''), listPage = ref(1), listTotalPages = ref(0)

// Drill-down
const fetchParams = ref({}), drillContext = ref('')

const totalCount = computed(() => {
  if (currentView.value === 'paper') return papers.value.reduce((s,p) => s+(p.error_count||0),0)
  if (currentView.value === 'time') return timeGroups.value.reduce((s,g) => s+g.errorCount,0)
  if (currentView.value === 'subject') return subjectGroups.value.reduce((s,g) => s+g.errorCount,0)
  return records.value.length
})

function subBadge(s){return ({'数学':'bg-blue-50 text-blue-700','物理':'bg-purple-50 text-purple-700','化学':'bg-green-50 text-green-700','生物':'bg-teal-50 text-teal-700','英语':'bg-orange-50 text-orange-700','语文':'bg-red-50 text-red-700'})[s]||'bg-gray-50 text-gray-600'}
function errBadge(t){return ({'概念不清':'bg-red-50 text-red-700','计算失误':'bg-yellow-50 text-yellow-700','审题偏差':'bg-purple-50 text-purple-700','方法错误':'bg-orange-50 text-orange-700','粗心马虎':'bg-blue-50 text-blue-700','知识盲区':'bg-gray-100 text-gray-700','表达不规范':'bg-pink-50 text-pink-700','逻辑错误':'bg-indigo-50 text-indigo-700'})[t]||'bg-gray-50 text-gray-600'}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts);return `${d.getMonth()+1}/${d.getDate()}`}

function setDrill(ctx, params){drillContext.value=ctx;fetchParams.value=params;currentView.value='list';filterSubject.value='';listPage.value=1;fetchList()}
function clearDrill(){drillContext.value='';fetchParams.value={};currentView.value='paper';listPage.value=1;fetchPaperView()}
function goPaperDetail(p){setDrill(`${p.subject} · ${p.title||'未命名'}（${p.error_count||0}题）`,{sessionId:p.id})}
function goTimeDetail(g){setDrill(`${g.timeLabel}（${g.errorCount}题）`,{timeFrom:g.startTs,timeTo:g.endTs})}
function goSubjectDetail(g){setDrill(`${g.subject}（${g.errorCount}题）`,{subject:g.subject})}

function switchView(v){clearDrill();currentView.value=v;fetchCurrentView()}

async function fetchPaperView(){loading.value=true;try{const r=await authFetch(`/api/error/list?view=paper&page=${paperPage.value}&limit=20`);const d=await r.json();if(d.success){papers.value=d.papers||[];paperTotalPages.value=d.totalPages||0}}catch(e){console.error(e)}finally{loading.value=false}}
async function fetchTimeView(){loading.value=true;try{const r=await authFetch('/api/error/list?view=time&period=month');const d=await r.json();if(d.success)timeGroups.value=d.results||[]}catch(e){console.error(e)}finally{loading.value=false}}
async function fetchSubjectView(){loading.value=true;try{const r=await authFetch('/api/error/list?view=subject');const d=await r.json();if(d.success)subjectGroups.value=d.results||[]}catch(e){console.error(e)}finally{loading.value=false}}
async function fetchList(){loading.value=true;try{const p=new URLSearchParams({page:String(listPage.value),limit:'20'});if(filterSubject.value)p.set('subject',filterSubject.value);if(fetchParams.value.subject)p.set('subject',fetchParams.value.subject);if(fetchParams.value.sessionId)p.set('sessionId',fetchParams.value.sessionId);if(fetchParams.value.timeFrom)p.set('timeFrom',String(fetchParams.value.timeFrom));if(fetchParams.value.timeTo)p.set('timeTo',String(fetchParams.value.timeTo));const r=await authFetch('/api/error/list?view=list&'+p);const d=await r.json();if(d.success){records.value=d.records||[];listTotalPages.value=d.totalPages||0}}catch(e){console.error(e)}finally{loading.value=false}}
function fetchCurrentView(){if(currentView.value==='paper')fetchPaperView();else if(currentView.value==='time')fetchTimeView();else if(currentView.value==='subject')fetchSubjectView();else fetchList()}
watch([currentView,paperPage,listPage,filterSubject],fetchCurrentView)
onMounted(fetchCurrentView)
</script>
