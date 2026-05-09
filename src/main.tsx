import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DynamicProvider } from './DynamicProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DynamicProvider>
      <App />
    </DynamicProvider>
  </StrictMode>,
)
