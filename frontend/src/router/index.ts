import { createRouter, createWebHistory } from 'vue-router'
import BasicLayout from '../layouts/BasicLayout.vue'
import { useUserStore } from '@/stores/user'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: BasicLayout,
      children: [
        {
          path: '',
          name: 'category-list',
          component: () => import('../views/CategoryList.vue'),
        },
        {
          path: 'problem-detail',
          name: 'problem-detail',
          component: () => import('../views/ProblemDetail.vue'),
        },
        {
          path: 'demo/virtual-list',
          name: 'demo-virtual-list',
          component: () => import('../views/VirtualListDemo.vue'),
        },
        {
          path: 'assistant',
          name: 'ai-assistant',
          component: () => import('../views/AiAssistant.vue'),
        },
        {
          path: 'admin/audit',
          name: 'admin-audit',
          component: () => import('../views/AuditLogs.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/SettingsView.vue'),
        },
      ],
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue')
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('../views/RegisterView.vue')
    }
  ],
})

router.beforeEach((to, from, next) => {
  const userStore = useUserStore()
  const publicPages = ['login', 'register']
  const authRequired = !publicPages.includes(to.name as string)

  if (authRequired && !userStore.isAuthenticated) {
    return next({ name: 'login' })
  }
  
  // Role based access control
  if (to.meta.requiresAdmin && !userStore.isAdmin) {
    return next({ name: 'category-list' })
  }

  // If already logged in and tries to go to login/register
  if (userStore.isAuthenticated && publicPages.includes(to.name as string)) {
    return next({ name: 'category-list' })
  }

  next()
})

export default router
