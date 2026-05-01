<template>
  <div class="max-w-md mx-auto px-4 sm:px-6 lg:px-8 py-16">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">注册</h1>
      <p class="text-gray-600">创建账号以管理您的作文批改记录</p>
    </div>

    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 错误提示 -->
      <div v-if="error" class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
        {{ error }}
      </div>

      <form @submit.prevent="handleRegister" class="space-y-5">
        <!-- 邮箱 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">邮箱 <span class="text-red-500">*</span></label>
          <input
            v-model="email"
            type="email"
            required
            autocomplete="email"
            placeholder="your@email.com"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">密码 <span class="text-red-500">*</span></label>
          <input
            v-model="password"
            type="password"
            required
            autocomplete="new-password"
            placeholder="至少6位"
            minlength="6"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 昵称 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">昵称</label>
          <input
            v-model="nickname"
            type="text"
            placeholder="默认使用邮箱前缀"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 地区（默认上海） -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">地区 <span class="text-red-500">*</span></label>
          <select
            v-model="region"
            required
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition bg-white"
          >
            <option value="上海">上海</option>
            <option value="北京">北京</option>
            <option value="天津">天津</option>
            <option value="重庆">重庆</option>
            <option value="河北">河北</option>
            <option value="山西">山西</option>
            <option value="辽宁">辽宁</option>
            <option value="吉林">吉林</option>
            <option value="黑龙江">黑龙江</option>
            <option value="江苏">江苏</option>
            <option value="浙江">浙江</option>
            <option value="安徽">安徽</option>
            <option value="福建">福建</option>
            <option value="江西">江西</option>
            <option value="山东">山东</option>
            <option value="河南">河南</option>
            <option value="湖北">湖北</option>
            <option value="湖南">湖南</option>
            <option value="广东">广东</option>
            <option value="广西">广西</option>
            <option value="海南">海南</option>
            <option value="四川">四川</option>
            <option value="贵州">贵州</option>
            <option value="云南">云南</option>
            <option value="西藏">西藏</option>
            <option value="陕西">陕西</option>
            <option value="甘肃">甘肃</option>
            <option value="青海">青海</option>
            <option value="宁夏">宁夏</option>
            <option value="新疆">新疆</option>
            <option value="内蒙古">内蒙古</option>
            <option value="香港">香港</option>
            <option value="澳门">澳门</option>
            <option value="台湾">台湾</option>
          </select>
        </div>

        <!-- 年级 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">年级</label>
          <select
            v-model="grade"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition bg-white"
          >
            <option value="">请选择（可选）</option>
            <option value="高一">高一</option>
            <option value="高二">高二</option>
            <option value="高三">高三</option>
          </select>
        </div>

        <!-- 学校 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">学校</label>
          <input
            v-model="school"
            type="text"
            placeholder="选填"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 提交 -->
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <!-- 登录引导 -->
      <div class="mt-6 text-center text-sm text-gray-500">
        已有账号？
        <router-link to="/login" class="text-blue-600 hover:text-blue-700 font-medium">立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { authStore } from '../utils/authStore.js'

const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const nickname = ref('')
const region = ref('上海')
const grade = ref('')
const school = ref('')
const loading = ref(false)
const error = ref(null)

async function handleRegister() {
  error.value = null
  if (password.value.length < 6) {
    error.value = '密码长度不能少于6位'
    return
  }
  loading.value = true
  try {
    await authStore.register({
      email: email.value,
      password: password.value,
      nickname: nickname.value || undefined,
      region: region.value,
      grade: grade.value || undefined,
      school: school.value || undefined
    })
    // 注册成功后跳转
    router.replace(route.query.redirect || '/')
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}
</script>
