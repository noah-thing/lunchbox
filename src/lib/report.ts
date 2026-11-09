// Any part of the app can open the report sheet with what just went wrong already filled in.
export type ReportOpen = { kind?: 'bug' | 'idea' | 'question'; context?: string }

export const openReport = (o: ReportOpen = {}) => dispatchEvent(new CustomEvent<ReportOpen>('lb:report', { detail: o }))
