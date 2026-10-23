import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LogAnalyzer from './components/LogAnalyzer'
import UiMotionPreferences from './components/UiMotionPreferences'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UiMotionPreferences />
    <LogAnalyzer />
  </StrictMode>,
)
