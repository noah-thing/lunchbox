import { Component, type ReactNode } from 'react'
import { desk } from '../lib/desk'
import { openReport } from '../lib/report'

// If a page throws while drawing, the rest of the app keeps working: the page is replaced by a
// short note with a way to report it and a way back.
export class Guard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }
  }
  componentDidCatch(e: unknown) {
    desk.call('error:log', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)).catch(() => {})
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <div className="pagebody">
          <header className="pagehead">
            <h1>This page hit a problem</h1>
            <p>Everything else still works, and nothing you made is lost. Sending this helps us fix it for everyone.</p>
          </header>
          <pre className="reportctx">{this.state.error.split('\n').slice(0, 6).join('\n')}</pre>
          <div className="row">
            <button className="btn small" onClick={() => openReport({ context: this.state.error ?? '' })}>Report this</button>
            <button className="btn small quiet" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      </div>
    )
  }
}
