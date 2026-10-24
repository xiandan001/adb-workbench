import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LogAnalyzer from './components/LogAnalyzer'
import UiMotionPreferences from './components/UiMotionPreferences'
import { initializeLanguage } from './shared/i18n.js'
import LogWindowTitle from './components/LogWindowTitle.jsx'

initializeLanguage().then(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LogWindowTitle />
    <UiMotionPreferences />
    <LogAnalyzer />
  </StrictMode>,
))
