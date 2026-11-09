import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import './pages.css'
import './look-neyra.css'
import { App } from './App'
import { desk } from './lib/desk'

// Errors anywhere in the window are kept for the report sheet, so a report says what went wrong.
addEventListener('error', (e) => { desk.call('error:log', `${e.message} at ${e.filename}:${e.lineno}`).catch(() => {}) })
addEventListener('unhandledrejection', (e) => { desk.call('error:log', String((e.reason as Error)?.stack ?? e.reason)).catch(() => {}) })

createRoot(document.getElementById('root')!).render(<App />)
