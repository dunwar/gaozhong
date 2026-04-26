<script setup>
// App.vue - 根组件，使用 Vue Router
</script>

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

export default {
  components: {
    Header,
    Footer
  }
}
</script>
