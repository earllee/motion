import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/editor.css'
import './styles/menus.css'
import './styles/polish.css'

createRoot(document.getElementById('root')!).render(<App />)
