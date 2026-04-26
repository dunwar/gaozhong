<template>
  <div 
    class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center transition-all cursor-pointer"
    :class="{ 'border-blue-500 bg-blue-50': isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="handleDrop"
    @click="triggerFileInput"
  >
    <input 
      ref="fileInput" 
      type="file" 
      accept="image/*,.pdf,.doc,.docx,.txt" 
      class="hidden" 
      @change="handleFileSelect"
    />
    
    <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
      <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    
    <p class="mt-4 text-sm text-gray-600">
      <span class="font-medium text-blue-600">点击上传</span> 或拖拽文件到这里
    </p>
    <p class="mt-1 text-xs text-gray-500">支持图片、PDF、Word、TXT 格式</p>
  </div>

  <!-- 文件预览 -->
  <div v-if="selectedFile" class="mt-4 p-4 bg-gray-50 rounded-lg">
    <div class="flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <svg class="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
        </svg>
        <div>
          <p class="text-sm font-medium text-gray-900">{{ selectedFile.name }}</p>
          <p class="text-xs text-gray-500">{{ formatFileSize(selectedFile.size) }}</p>
        </div>
      </div>
      <button @click="clearFile" class="text-gray-400 hover:text-red-500">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>
    <img v-if="isImage" :src="previewUrl" class="mt-3 max-h-48 mx-auto rounded" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const emit = defineEmits(['file-selected'])

const isDragging = ref(false)
const selectedFile = ref(null)
const fileInput = ref(null)
const previewUrl = ref(null)

const isImage = computed(() => {
  return selectedFile.value && selectedFile.value.type.startsWith('image/')
})

const triggerFileInput = () => {
  fileInput.value?.click()
}

const handleFileSelect = (event) => {
  const file = event.target.files[0]
  if (file) {
    setFile(file)
  }
}

const handleDrop = (event) => {
  isDragging.value = false
  const file = event.dataTransfer.files[0]
  if (file) {
    setFile(file)
  }
}

const setFile = (file) => {
  selectedFile.value = file
  
  // 生成图片预览
  if (file.type.startsWith('image/')) {
    const reader = new FileReader()
    reader.onload = (e) => {
      previewUrl.value = e.target.result
    }
    reader.readAsDataURL(file)
  }
  
  emit('file-selected', file)
}

const clearFile = () => {
  selectedFile.value = null
  previewUrl.value = null
  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
</script>
