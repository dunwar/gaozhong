import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Upload from '../views/Upload.vue'
import Result from '../views/Result.vue'
import Login from '../views/Login.vue'
import { authStore } from '../utils/authStore.js'

const SITE_NAME = '高中在线'

const routes = [
  {
    path: '/', name: 'Home', component: Home,
    meta: {
      title: '上海高考作文批改AI＋试卷错题整理——批得比学校细，错题不用抄',
      description: '高中生AI学习管家：作文每周细批（上海70分制五维评分+逐句点评+升格示范），已批改试卷拍照自动生成错题本和可打印订正纸。免注册体验示例卷，新用户送3点。'
    }
  },

  // ===== 作文批改模块 =====
  {
    path: '/upload', name: 'Upload', component: Upload,
    meta: {
      title: '免费AI作文批改｜拍照上传，上海70分制细批',
      description: '手机拍下手写作文，AI按上海高考评分口径批改：五维得分、逐句标注、升格示范。第一篇免费，约2分钟出报告。'
    }
  },
  { path: '/tasks', name: 'Tasks', component: () => import('../views/Tasks.vue') },
  { path: '/result', name: 'Result', component: Result },
  { path: '/result/:taskId', name: 'ResultById', component: Result },
  { path: '/history', name: 'History', component: () => import('../views/History.vue'), meta: { requiresAuth: true } },

  // ===== 错题整理模块 =====
  { path: '/paper/upload', name: 'PaperUpload', component: () => import('../views/PaperUpload.vue'), meta: { requiresAuth: true } },
  { path: '/error/list', name: 'ErrorWorkbook', component: () => import('../views/ErrorWorkbook.vue'), meta: { requiresAuth: true } },
  { path: '/error/export', name: 'PaperExport', component: () => import('../views/PaperExport.vue'), meta: { requiresAuth: true } },
  { path: '/error/:id', name: 'ErrorDetail', component: () => import('../views/ErrorDetail.vue'), meta: { requiresAuth: true } },
  { path: '/paper/:sessionId/errors', name: 'PaperErrors', component: () => import('../views/PaperErrors.vue'), meta: { requiresAuth: true } },
  { path: '/knowledge', name: 'KnowledgeMap', component: () => import('../views/KnowledgeMap.vue'), meta: { requiresAuth: true } },
  { path: '/review/:sessionId', name: 'PaperReview', component: () => import('../views/PaperReview.vue'), meta: { requiresAuth: true } },
  {
    path: '/confirm/:sessionId', name: 'PaperConfirm', component: () => import('../views/PaperConfirm.vue'),
    meta: { title: '确认错题' } // 免登录: 支持示例卷体验(非demo session后端仍校验)
  },

  // ===== 内容文章(SEO承载, 免登录) =====
  { path: '/articles/:slug', name: 'Article', component: () => import('../views/Article.vue') },

  // ===== 充值 =====
  {
    path: '/pricing', name: 'Pricing', component: () => import('../views/Pricing.vue'),
    meta: {
      title: '点数说明与充值｜1点=1次作文批改或1份试卷整理',
      description: '点数制：1点可批改1篇作文或整理1份试卷。新用户注册送3点，微信扫码人工充值即时到账。'
    }
  },

  // ===== 认证 =====
  { path: '/login', name: 'Login', component: Login, meta: { title: '登录' } },
  {
    path: '/register', name: 'Register', component: () => import('../views/Register.vue'),
    meta: { title: '免费注册送3点' }
  },
  { path: '/password', name: 'Password', component: () => import('../views/Password.vue'), meta: { requiresAuth: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 导航守卫：需要登录的路由自动跳转
router.beforeEach((to, from, next) => {
  if (to.meta.requiresAuth && !authStore.isLoggedIn) {
    next({ path: '/login', query: { redirect: to.fullPath } })
  } else {
    next()
  }
})

// 路由后处理: 独立 title/meta(SEO) + 百度统计 PV 上报
// 首次加载由 index.html 统计脚本自动记录, 跳过避免重复
let firstRoute = true
router.afterEach((to) => {
  // 每页独立 title + description
  document.title = to.meta.title ? `${to.meta.title}｜${SITE_NAME}` : `${SITE_NAME} - AI 驱动的高中学业诊断平台`
  if (to.meta.description) {
    let desc = document.querySelector('meta[name="description"]')
    if (!desc) {
      desc = document.createElement('meta')
      desc.setAttribute('name', 'description')
      document.head.appendChild(desc)
    }
    desc.setAttribute('content', to.meta.description)
  }

  if (firstRoute) { firstRoute = false; return }
  if (typeof window._hmt !== 'undefined' && Array.isArray(window._hmt)) {
    window._hmt.push(['_trackPageview', to.fullPath])
  }
})

export default router
