import { render } from 'preact'
import { App } from './app.tsx'
import './global.css'

const root = document.getElementById('app')
if (root) {
  // 清掉 index.html 里的 splash
  root.innerHTML = ''
  render(<App />, root)
}
