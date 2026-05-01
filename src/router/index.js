import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Upload from '../views/Upload.vue'
import Result from '../views/Result.vue'

const routes = [
  { path: '/', name: 'Home', component: Home },
  { path: '/upload', name: 'Upload', component: Upload },
  { path: '/result', name: 'Result', component: Result },
  { path: '/result/:taskId', name: 'ResultById', component: Result },
  { path: '/history', name: 'History', component: () => import('../views/History.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
