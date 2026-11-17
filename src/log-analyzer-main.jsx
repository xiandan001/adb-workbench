import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LogWindowApp from './components/LogWindowApp.jsx'
import UiMotionPreferences from './components/UiMotionPreferences'
import { initializeLanguage } from './shared/i18n.js'
import LogWindowTitle from './components/LogWindowTitle.jsx'
import LogWindowStartupBoundary, { LogWindowReady } from './components/LogWindowStartupBoundary.jsx'
import { startLogWindow } from './shared/logWindowBootstrap.js'

startLogWindow({ initializeLanguage, onFailure: () => console.warn('[LogWindow] language-unavailable'), render: () => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LogWindowTitle />
    <UiMotionPreferences />
    <LogWindowStartupBoundary><LogWindowApp /><LogWindowReady /></LogWindowStartupBoundary>
  </StrictMode>,
) })
