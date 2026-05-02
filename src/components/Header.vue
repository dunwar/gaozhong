<template>
  <header class="bg-white shadow-sm sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between items-center h-16">
        <!-- Logo -->
        <router-link to="/" class="flex items-center space-x-2">
          <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>
            </svg>
          </div>
          <span class="text-xl font-bold text-gray-900">高中在线</span>
        </router-link>

        <!-- Desktop Navigation -->
        <nav class="hidden md:flex items-center space-x-6">
          <router-link to="/" class="text-gray-600 hover:text-blue-600 transition-colors">首页</router-link>
          <router-link to="/upload" class="text-gray-600 hover:text-blue-600 transition-colors">作文批改</router-link>
          <router-link to="/tasks" class="text-gray-600 hover:text-blue-600 transition-colors relative flex items-center gap-1">
            我的任务
            <span
              v-if="unreadCount > 0"
              class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-red-500 text-white rounded-full"
            >{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
          </router-link>
          <router-link to="/history" class="text-gray-600 hover:text-blue-600 transition-colors">历史记录</router-link>
          <router-link to="/error-upload" class="text-gray-600 hover:text-blue-600 transition-colors">错题诊断</router-link>

          <span class="text-gray-300">|</span>

          <!-- 已登录 -->
          <template v-if="authStore.isLoggedIn">
            <div class="relative" @click.stop>
              <button
                @click="dropdownOpen = !dropdownOpen"
                class="flex items-center gap-1.5 text-gray-700 hover:text-blue-600 transition-colors"
              >
                <span v-if="authStore.mustChangePassword" class="w-2 h-2 bg-orange-400 rounded-full" title="需修改密码"></span>
                <span class="text-sm font-medium">{{ authStore.user?.nickname || authStore.user?.email }}</span>
                <svg class="w-3 h-3 transition-transform" :class="{ 'rotate-180': dropdownOpen }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                </svg>
              </button>
              <!-- Dropdown -->
              <div
                v-if="dropdownOpen"
                class="absolute right-0 mt-2 w-44 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50"
              >
                <router-link
                  to="/password"
                  @click="dropdownOpen = false"
                  class="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                  </svg>
                  修改密码
                  <span v-if="authStore.mustChangePassword" class="ml-auto w-2 h-2 bg-orange-400 rounded-full"></span>
                </router-link>
                <hr class="my-1 border-gray-100" />
                <button
                  @click="handleLogout"
                  class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                  </svg>
                  退出登录
                </button>
              </div>
            </div>
          </template>

          <!-- 未登录 -->
          <template v-else>
            <router-link to="/login" class="text-sm text-gray-600 hover:text-blue-600 transition-colors">登录</router-link>
            <router-link to="/register" class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">注册</router-link>
          </template>
        </nav>

        <!-- Mobile menu button -->
        <button @click="mobileMenuOpen = !mobileMenuOpen" class="md:hidden p-2 relative">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
          </svg>
          <span
            v-if="unreadCount > 0"
            class="absolute top-0 right-0 w-4 h-4 text-[9px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center"
          >{{ unreadCount > 9 ? '!' : unreadCount }}</span>
        </button>
      </div>

      <!-- Mobile menu -->
      <div v-if="mobileMenuOpen" class="md:hidden py-4 border-t space-y-1">
        <router-link to="/" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">首页</router-link>
        <router-link to="/upload" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">作文批改</router-link>
        <router-link to="/tasks" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">
          我的任务
          <span v-if="unreadCount > 0" class="ml-1 text-xs text-red-500">({{ unreadCount }})</span>
        </router-link>
        <router-link to="/history" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">历史记录</router-link>
        <router-link to="/error-upload" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">错题诊断</router-link>

        <hr class="my-2 border-gray-100" />

        <!-- 移动端认证 -->
        <template v-if="authStore.isLoggedIn">
          <div class="px-2 py-2 text-sm text-gray-500">
            {{ authStore.user?.nickname || authStore.user?.email }}
            <span v-if="authStore.mustChangePassword" class="ml-1 text-xs text-orange-500">（需修改密码）</span>
          </div>
          <router-link to="/password" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">修改密码</router-link>
          <button @click="handleLogout" class="block w-full text-left py-2 text-red-600">退出登录</button>
        </template>
        <template v-else>
          <router-link to="/login" class="block py-2 text-gray-600 hover:text-blue-600" @click="mobileMenuOpen = false">登录</router-link>
          <router-link to="/register" class="block py-2 text-blue-600 font-medium" @click="mobileMenuOpen = false">注册</router-link>
        </template>
      </div>
    </div>
  </header>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { authStore } from '../utils/authStore.js'
import { getUnreadCount } from '../utils/taskStore.js'

const router = useRouter()

const mobileMenuOpen = ref(false)
const dropdownOpen = ref(false)
const unreadCount = ref(0)
let pollTimer = null

function refreshBadge() {
  unreadCount.value = getUnreadCount()
}

function handleLogout() {
  dropdownOpen.value = false
  mobileMenuOpen.value = false
  authStore.logout()
  router.push('/')
}

// 点击外部关闭下拉
function onClickOutside(e) {
  if (dropdownOpen.value) {
    dropdownOpen.value = false
  }
}

onMounted(() => {
  refreshBadge()
  pollTimer = setInterval(refreshBadge, 3000)
  document.addEventListener('click', onClickOutside)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  document.removeEventListener('click', onClickOutside)
})
</script>
