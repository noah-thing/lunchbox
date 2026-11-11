// One stroke weight, one grid. 16 by 16, 1.25 px lines, square caps, so they sit with the cells.
const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, 'aria-hidden': true } as const

export const IconPlus = () => <svg {...P}><path d="M8 3v10M3 8h10" /></svg>
export const IconX = () => <svg {...P} strokeWidth={1.4}><path d="M3.5 3h3l6 10h-3z" /><path d="M12.5 3 8.6 7.4M3.5 13l3.9-4.4" /></svg>
export const IconGlobe = () => <svg {...P}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.6 5.9 5.6 8s.8 3.9 2.4 5.5" /></svg>
export const IconSearch = () => <svg {...P}><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13 13" /></svg>
export const IconFolderPlus = () => <svg {...P}><path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z" /><path d="M8 7.6v3.2M6.4 9.2h3.2" /></svg>
export const IconFolder = () => <svg {...P}><path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z" /></svg>
export const IconPanel = () => <svg {...P}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M10 3v10" /></svg>
export const IconUp = () => <svg {...P} strokeWidth={1.5}><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg>
export const IconDown = () => <svg {...P} width={10} height={10}><path d="M4 6l4 4 4-4" /></svg>
export const IconAgents = () => <svg {...P}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
export const IconSettings = () => <svg {...P}><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" /><circle cx="10" cy="5" r="1.5" /><circle cx="6" cy="11" r="1.5" /></svg>
export const IconMore = () => <svg {...P}><circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" /></svg>
export const IconInbox = () => <svg {...P}><path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11zM2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2" /></svg>
export const IconReview = () => <svg {...P}><path d="M7 12.5a5.5 5.5 0 1 1 3.9-1.6L13.5 13.5" /><path d="M5 7.2l1.5 1.5L9.2 6" /></svg>
export const IconPin = () => <svg {...P}><path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" /></svg>
export const IconFork = () => <svg {...P}><circle cx="4.5" cy="3.5" r="1.25" /><circle cx="11.5" cy="3.5" r="1.25" /><circle cx="8" cy="12.5" r="1.25" /><path d="M4.5 4.75V6c0 1.5 1 2.25 3.5 2.75V11.25M11.5 4.75V6c0 1.5-1 2.25-3.5 2.75" /></svg>
export const IconCopy = () => <svg {...P}><rect x="5.5" y="5.5" width="8" height="8" rx="1.25" /><path d="M10.5 3.5v-1h-8v8h1" /></svg>
// Printer's crop marks around the work: Studio.
export const IconStudio = () => <svg {...P}><path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" /><rect x="6" y="6" width="4" height="4" rx=".75" /></svg>
export const IconSplit = () => <svg {...P}><rect x="2.5" y="3" width="4.75" height="10" rx="1.25" /><rect x="8.75" y="3" width="4.75" height="10" rx="1.25" /></svg>
export const IconCheck = () => <svg {...P} strokeWidth={1.5}><path d="M3.5 8.5l3 3 6-7" /></svg>
export const IconClose = () => <svg {...P}><path d="M4 4l8 8M12 4l-8 8" /></svg>
export const IconPlay = () => <svg {...P}><path d="M5 3.5v9l7-4.5z" /></svg>
export const IconFlows = () => <svg {...P}><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="8" r="1.5" /><circle cx="4" cy="12" r="1.5" /><path d="M5.5 4h2.5c1.5 0 2 1 2.3 2.6M5.5 12h2.5c1.5 0 2-1 2.3-2.6" /></svg>
export const IconPool = () => <svg {...P}><path d="M2.5 13.5h11" /><rect x="3.5" y="8" width="2" height="3.5" /><rect x="7" y="5" width="2" height="6.5" /><rect x="10.5" y="2.5" width="2" height="9" /></svg>
// Three stacked coins, the top one a reused copy of the one below.
export const IconSave = () => <svg {...P}><ellipse cx="8" cy="4.5" rx="5" ry="2" /><path d="M3 4.5v3.5c0 1.1 2.24 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.24 2 5 2s5-.9 5-2V8" /></svg>
export const IconLibrary = () => <svg {...P}><rect x="2.5" y="2.5" width="3" height="11" rx=".75" /><rect x="6.5" y="2.5" width="3" height="11" rx=".75" /><path d="M10.6 3.2l2.6-.7 2 10.5-2.6.7z" transform="translate(-1.6 .3)" /></svg>
export const IconClip = () => <svg {...P}><path d="M12.5 7.5 8 12a3 3 0 0 1-4.25-4.25l5-5a2 2 0 0 1 2.83 2.83L6.8 10.4a1 1 0 0 1-1.4-1.4L9.8 4.6" /></svg>
export const IconDiff = () => <svg {...P}><path d="M5 2.5v7M1.5 6h7M8 13h6.5" /><path d="M11 3v7M8.5 7.5 11 10l2.5-2.5" /></svg>
export const IconRewind = () => <svg {...P}><path d="M3 3v3.5h3.5" /><path d="M3.4 6.3A5 5 0 1 1 3.5 10" /></svg>
export const IconShare = () => <svg {...P}><path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v5h9v-5" /></svg>
export const IconPhone = () => <svg {...P}><rect x="4.5" y="2" width="7" height="12" rx="1.5" /><path d="M7 11.75h2" /></svg>
export const IconClock = () => <svg {...P}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.25l2 1.25" /></svg>
export const IconBrowser = () => <svg {...P}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12" /><circle cx="4" cy="4.5" r=".4" fill="currentColor" /></svg>
export const IconBack = () => <svg {...P}><path d="M9.5 4 5.5 8l4 4" /></svg>
export const IconForward = () => <svg {...P}><path d="M6.5 4l4 4-4 4" /></svg>
export const IconReload = () => <svg {...P}><path d="M12.5 7.5A4.5 4.5 0 1 0 11 11" /><path d="M12.75 3.5v4h-4" /></svg>
export const IconCamera = () => <svg {...P}><rect x="2" y="4.5" width="12" height="8.5" rx="1.5" /><circle cx="8" cy="8.75" r="2.25" /><path d="M5.5 4.5 6.5 3h3l1 1.5" /></svg>
export const IconCode = () => <svg {...P}><path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" /></svg>
export const IconBranches = () => <svg {...P}><circle cx="4" cy="3.5" r="1.5" /><path d="M4 5v8" /><path d="M4 7.5c0 1.6 1 2 2.6 2h3.9" /><path d="M4 5.8c0 .9.7 1.2 1.6 1.2h4.9" /><circle cx="12" cy="7" r="1.25" /><circle cx="12" cy="9.5" r="1.25" /></svg>
export const IconChevron = () => <svg className="chev" width="10" height="10" viewBox="0 0 16 16" aria-hidden><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
export const IconStop = () => <svg {...P}><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" /></svg>
