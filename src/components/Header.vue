<template>
  <header class="bg-white/95 backdrop-blur-sm shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between items-center h-14 md:h-16">
        <!-- Logo -->
        <router-link to="/" class="flex items-center gap-2.5 flex-shrink-0">
          <div class="w-8 h-8 md:w-9 md:h-9 bg-blue-600 rounded-xl flex items-center justify-center shadow-sm">
            <svg class="w-[18px] h-[18px] md:w-5 md:h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
            </svg>
          </div>
          <span class="text-lg md:text-xl font-bold text-gray-900 tracking-tight">高中在线</span>
        </router-link>

        <!-- Desktop Navigation -->
        <nav class="hidden lg:flex items-center gap-0.5">
          <router-link to="/" class="nav-link" exact-active-class="nav-active">首页</router-link>

          <span class="w-px h-5 bg-gray-200 mx-2"></span>

          <!-- 作文批改 Dropdown -->
          <div class="relative group">
            <button class="nav-link flex items-center gap-1" :class="{ 'text-blue-600': isEssayRoute }">
              ✏️ 作文批改
              <svg class="w-3 h-3 opacity-50 group-hover:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <!-- invisible hover bridge (fills the gap) -->
            <div class="absolute top-full left-0 w-full h-2 group-hover:block hidden"></div>
            <div class="absolute top-[calc(100%+0.5rem)] left-0 w-40 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50 hidden group-hover:block">
              <router-link to="/upload" class="dropdown-link">作文批改</router-link>
              <router-link to="/tasks" class="dropdown-link flex items-center justify-between">
                我的任务
                <span v-if="unreadCount > 0" class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-red-500 text-white rounded-full">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
              </router-link>
              <router-link to="/history" class="dropdown-link">历史记录</router-link>
            </div>
          </div>

          <span class="w-px h-5 bg-gray-200 mx-2"></span>

          <!-- 错题整理 Dropdown -->
          <div class="relative group">
            <button class="nav-link flex items-center gap-1" :class="{ 'text-emerald-600': isWorkbookRoute }">
              📔 错题整理
              <svg class="w-3 h-3 opacity-50 group-hover:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="absolute top-full left-0 w-full h-2 group-hover:block hidden"></div>
            <div class="absolute top-[calc(100%+0.5rem)] left-0 w-36 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50 hidden group-hover:block">
              <router-link to="/paper/upload" class="dropdown-link">错题上传</router-link>
              <router-link to="/error/list" class="dropdown-link">错题本</router-link>
              <router-link to="/knowledge" class="dropdown-link">知识点</router-link>
            </div>
          </div>

          <span class="w-px h-5 bg-gray-200 mx-2"></span>

          <!-- 已登录 -->
          <template v-if="authStore.isLoggedIn">
            <div class="relative group">
              <button class="nav-link flex items-center gap-1.5">
                <span v-if="authStore.mustChangePassword" class="w-2 h-2 bg-orange-400 rounded-full" title="需修改密码"></span>
                <span class="max-w-[100px] truncate">{{ authStore.user?.nickname || authStore.user?.email }}</span>
                <svg class="w-3 h-3 opacity-50 group-hover:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
              </button>
              <div class="absolute top-full right-0 w-full h-2 group-hover:block hidden"></div>
              <div class="absolute top-[calc(100%+0.5rem)] right-0 w-40 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50 hidden group-hover:block">
                <router-link to="/password" class="dropdown-link">
                  修改密码
                  <span v-if="authStore.mustChangePassword" class="ml-1 w-2 h-2 bg-orange-400 rounded-full inline-block"></span>
                </router-link>
                <hr class="my-1 border-gray-100" />
                <button @click="handleLogout" class="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors">退出登录</button>
              </div>
            </div>
          </template>
          <template v-else>
            <router-link to="/login" class="text-sm text-gray-600 hover:text-blue-600 px-3 py-1.5 transition-colors">登录</router-link>
            <router-link to="/register" class="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition-colors ml-1">注册</router-link>
          </template>
        </nav>

        <!-- Mobile menu button -->
        <button @click="mobileOpen = !mobileOpen" class="lg:hidden p-2 -mr-2 relative">
          <svg class="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path v-if="!mobileOpen" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
            <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
          <span v-if="unreadCount > 0" class="absolute top-0 right-0 w-4 h-4 text-[9px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center">{{ unreadCount > 9 ? '!' : unreadCount }}</span>
        </button>
      </div>

      <!-- Mobile Drawer -->
      <Transition name="slide">
        <div v-if="mobileOpen" class="lg:hidden border-t border-gray-100 py-3 space-y-0.5">
          <router-link to="/" class="mobile-link" @click="mobileOpen = false">首页</router-link>

          <div class="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">✏️ 作文批改</div>
          <router-link to="/upload" class="mobile-link" @click="mobileOpen = false">作文批改</router-link>
          <router-link to="/tasks" class="mobile-link" @click="mobileOpen = false">
            我的任务
            <span v-if="unreadCount > 0" class="ml-2 text-xs text-red-500">({{ unreadCount }})</span>
          </router-link>
          <router-link to="/history" class="mobile-link" @click="mobileOpen = false">历史记录</router-link>

          <div class="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">📔 错题整理</div>
          <router-link to="/paper/upload" class="mobile-link" @click="mobileOpen = false">错题上传</router-link>
          <router-link to="/error/list" class="mobile-link" @click="mobileOpen = false">错题本</router-link>
          <router-link to="/knowledge" class="mobile-link" @click="mobileOpen = false">知识点</router-link>

          <hr class="my-2 border-gray-100 mx-4" />

          <template v-if="authStore.isLoggedIn">
            <div class="px-4 py-2 text-sm text-gray-500">{{ authStore.user?.nickname || authStore.user?.email }}</div>
            <router-link to="/password" class="mobile-link" @click="mobileOpen = false">修改密码</router-link>
            <button @click="handleLogout" class="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">退出登录</button>
          </template>
          <template v-else>
            <router-link to="/login" class="mobile-link" @click="mobileOpen = false">登录</router-link>
            <router-link to="/register" class="mobile-link text-blue-600 font-medium" @click="mobileOpen = false">注册</router-link>
          </template>
        </div>
      </Transition>
    </div>
  </header>
</template>

<style scoped>
.nav-link {
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #4b5563;
  border-radius: 0.5rem;
  transition: color 0.15s, background-color 0.15s;
  white-space: nowrap;
}
.nav-link:hover {
  color: #2563eb;
  background-color: #f9fafb;
}
.nav-active {
  color: #2563eb;
  background-color: #eff6ff;
}
.dropdown-link {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: #374151;
  transition: background-color 0.15s, color 0.15s;
}
.dropdown-link:hover {
  background-color: #f9fafb;
  color: #2563eb;
}
.mobile-link {
  display: block;
  padding: 0.625rem 1rem;
  font-size: 0.875rem;
  color: #374151;
  transition: background-color 0.15s;
}
.mobile-link:hover {
  background-color: #f9fafb;
}

.slide-enter-active { transition: all 0.2s ease-out; }
.slide-leave-active { transition: all 0.15s ease-in; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authStore } from '../utils/authStore.js'
import { getUnreadCount } from '../utils/taskStore.js'

const route = useRoute()
const router = useRouter()
const mobileOpen = ref(false)
const unreadCount = ref(0)
let pollTimer = null

const isEssayRoute = computed(() => ['/upload', '/tasks', '/result', '/history'].some(p => route.path.startsWith(p)))
const isWorkbookRoute = computed(() => ['/paper', '/error', '/knowledge', '/review'].some(p => route.path.startsWith(p)))

function refreshBadge() { unreadCount.value = getUnreadCount() }

function handleLogout() {
  mobileOpen.value = false
  authStore.logout()
  router.push('/')
}

onMounted(() => {
  refreshBadge()
  pollTimer = setInterval(refreshBadge, 5000)
})

onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>
