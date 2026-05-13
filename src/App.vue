<template>
  <div class="min-h-screen bg-gray-50 flex flex-col">
    <Header />
    <main class="flex-1">
      <router-view />
    </main>
    <Footer />
  </div>
</template>

<script>
import Header from './components/Header.vue'
import Footer from './components/Footer.vue'
import { startPaperPolling, stopPaperPolling } from './utils/paperTaskPoller.js'

export default {
  components: { Header, Footer },
  mounted() { startPaperPolling() },
  beforeUnmount() { stopPaperPolling() }
}
</script>
