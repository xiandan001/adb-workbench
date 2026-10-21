import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { restoreStartupData } from './shared/dataMigrationBootstrap'

restoreStartupData().then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode><App /></StrictMode>,
  )
}).catch(error => {
  const root = document.getElementById('root')
  const message = document.createElement('p')
  message.textContent = `数据恢复未完成，应用尚未写入新的偏好。请保留恢复备份后重启：${error.message}`
  message.style.padding = '32px'
  root.replaceChildren(message)
})
