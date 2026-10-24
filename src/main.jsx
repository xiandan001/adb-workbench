import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { restoreStartupData } from './shared/dataMigrationBootstrap'
import StartupReady from './components/StartupReady'
import UiMotionPreferences from './components/UiMotionPreferences'
import { initializeLanguage, tr } from './shared/i18n.js'

restoreStartupData().then(initializeLanguage).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode><UiMotionPreferences /><App /><StartupReady /></StrictMode>,
  )
}).catch(() => {
  const description = tr('数据恢复未完成，已暂停启动以保护现有偏好。请保留恢复备份并重新启动应用。')
  if (window.__workbenchStartup) {
    window.__workbenchStartup.fail(description)
    return
  }
  const root = document.getElementById('root')
  const message = document.createElement('p')
  message.textContent = description
  message.style.padding = '32px'
  document.getElementById('app-startup')?.remove()
  root.removeAttribute('inert')
  root.setAttribute('aria-busy', 'false')
  root.replaceChildren(message)
})
