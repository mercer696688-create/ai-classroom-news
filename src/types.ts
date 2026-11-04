export type Interviewee = 'teacher'

export type Phase =
  | 'welcome'
  | 'asking'
  | 'awaiting-consent'
  | 'listening'
  | 'needs-confirmation'
  | 'review'
  | 'broadcasting'
  | 'round-complete'
  | 'all-complete'

export interface Answer {
  transcript: string
  value: string
  approved: boolean
}

export interface InterviewSession {
  interviewee: Interviewee
  answers: Answer[]
  completed: boolean
  reportLines: string[]
}

export interface AppState {
  phase: Phase
  currentInterviewee: Interviewee
  questionIndex: number
  transcript: string
  interimTranscript: string
  caption: string
  warning: string
  autoListen: boolean
  speechSupported: boolean
  recognitionSupported: boolean
  isPaused: boolean
  isSpeaking: boolean
  isRecognizing: boolean
  teacher: InterviewSession
  expectedValues: Record<Interviewee, [string, string, string]>
}
