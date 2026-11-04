import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import DigitNormalizationBoundary from './components/DigitNormalizationBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DigitNormalizationBoundary>
      <App />
    </DigitNormalizationBoundary>
  </StrictMode>,
)
