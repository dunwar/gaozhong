import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Upload from '../views/Upload.vue'
import Result from '../views/Result.vue'

const routes = [
  { path: '/', name: 'Home', component: Home },
  { path: '/upload', name: 'Upload', component: Upload },
  { path: '/result', name: 'Result', component: Result },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
