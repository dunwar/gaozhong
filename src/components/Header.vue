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

        <!-- Navigation -->
        <nav class="hidden md:flex items-center space-x-8">
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
      </div>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { loadTasks, getUnreadCount } from '../utils/taskStore.js'

const mobileMenuOpen = ref(false)
const unreadCount = ref(0)
let pollTimer = null

function refreshBadge() {
  unreadCount.value = getUnreadCount()
}

onMounted(() => {
  refreshBadge()
  pollTimer = setInterval(refreshBadge, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
