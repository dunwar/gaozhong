import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { restoreAuth } from './utils/authStore.js'
import './style.css'

const app = createApp(App)
app.use(router)
app.mount('#app')

// 启动时恢复登录态
restoreAuth()
