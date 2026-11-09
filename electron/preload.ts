import { contextBridge, ipcRenderer, webUtils } from 'electron'

const EVENTS = new Set(['agents', 'rooms', 'room:event', 'room:live', 'room:meta', 'ledger', 'skills', 'flows', 'remote', 'browser', 'tools', 'open-room', 'local:pull'])

contextBridge.exposeInMainWorld('lb', {
  call: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (value: unknown) => void) => {
    if (!EVENTS.has(channel)) return () => {}
    const listener = (_e: unknown, value: unknown) => fn(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathOf: (file: File) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
})
