import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Upload from '../views/Upload.vue'
import Result from '../views/Result.vue'
import Login from '../views/Login.vue'
import { authStore } from '../utils/authStore.js'

const routes = [
  { path: '/', name: 'Home', component: Home },
  { path: '/upload', name: 'Upload', component: Upload },
  { path: '/tasks', name: 'Tasks', component: () => import('../views/Tasks.vue') },
  { path: '/result', name: 'Result', component: Result },
  { path: '/result/:taskId', name: 'ResultById', component: Result },
  { path: '/history', name: 'History', component: () => import('../views/History.vue'), meta: { requiresAuth: true } },
  { path: '/login', name: 'Login', component: Login },
  { path: '/register', name: 'Register', component: () => import('../views/Register.vue') },
  { path: '/password', name: 'Password', component: () => import('../views/Password.vue'), meta: { requiresAuth: true } },
  { path: '/error-upload', name: 'ErrorUpload', component: () => import('../views/ErrorUpload.vue'), meta: { requiresAuth: true } },
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

export default router
