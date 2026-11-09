// One stroke weight, one grid. 16 by 16, 1.25 px lines, square caps, so they sit with the cells.
const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, 'aria-hidden': true } as const

export const IconPlus = () => <svg {...P}><path d="M8 3v10M3 8h10" /></svg>
export const IconSearch = () => <svg {...P}><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13 13" /></svg>
export const IconFolder = () => <svg {...P}><path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z" /></svg>
export const IconPanel = () => <svg {...P}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M10 3v10" /></svg>
export const IconUp = () => <svg {...P} strokeWidth={1.5}><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg>
export const IconDown = () => <svg {...P} width={10} height={10}><path d="M4 6l4 4 4-4" /></svg>
export const IconAgents = () => <svg {...P}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
export const IconSettings = () => <svg {...P}><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" /><circle cx="10" cy="5" r="1.5" /><circle cx="6" cy="11" r="1.5" /></svg>
export const IconMore = () => <svg {...P}><circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" /></svg>
export const IconPin = () => <svg {...P}><path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" /></svg>
export const IconFork = () => <svg {...P}><circle cx="4.5" cy="3.5" r="1.25" /><circle cx="11.5" cy="3.5" r="1.25" /><circle cx="8" cy="12.5" r="1.25" /><path d="M4.5 4.75V6c0 1.5 1 2.25 3.5 2.75V11.25M11.5 4.75V6c0 1.5-1 2.25-3.5 2.75" /></svg>
export const IconCopy = () => <svg {...P}><rect x="5.5" y="5.5" width="8" height="8" rx="1.25" /><path d="M10.5 3.5v-1h-8v8h1" /></svg>
export const IconSplit = () => <svg {...P}><rect x="2.5" y="3" width="4.75" height="10" rx="1.25" /><rect x="8.75" y="3" width="4.75" height="10" rx="1.25" /></svg>
export const IconCheck = () => <svg {...P} strokeWidth={1.5}><path d="M3.5 8.5l3 3 6-7" /></svg>
export const IconClose = () => <svg {...P}><path d="M4 4l8 8M12 4l-8 8" /></svg>
export const IconPlay = () => <svg {...P}><path d="M5 3.5v9l7-4.5z" /></svg>
export const IconStop = () => <svg {...P}><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" /></svg>
