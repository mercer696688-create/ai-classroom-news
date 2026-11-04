import type { Answer, AppState, InterviewSession, Interviewee } from './types'

export const QUESTIONS = [
  "What's your favorite subject?",
  'Why do you like it?',
  'What other subjects do you like?',
] as const

export const QUESTION_LEADS = ['Question one.', 'Question two.', 'Question three.'] as const

export const DEFAULT_VALUES: Record<Interviewee, [string, string, string]> = {
  teacher: ['English', 'fun', 'Chinese'],
}

export function emptyAnswers(): Answer[] {
  return QUESTIONS.map(() => ({ transcript: '', value: '', approved: false }))
}

export function createSession(interviewee: Interviewee): InterviewSession {
  return { interviewee, answers: emptyAnswers(), completed: false, reportLines: [] }
}

export function createInitialState(): AppState {
  return {
    phase: 'welcome',
    currentInterviewee: 'teacher',
    questionIndex: 0,
    transcript: '',
    interimTranscript: '',
    caption: 'Welcome to AI Classroom News',
    warning: '',
    autoListen: true,
    speechSupported: typeof window !== 'undefined' && 'speechSynthesis' in window,
    recognitionSupported:
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
    isPaused: false,
    isSpeaking: false,
    isRecognizing: false,
    teacher: createSession('teacher'),
    expectedValues: structuredClone(DEFAULT_VALUES),
  }
}

export function buildReport(interviewee: Interviewee, values: string[]): string[] {
  const [favorite = '', reason = '', other = ''] = values.map((value) => value.trim())
  return [
    'Hello, everyone.',
    "Miss Wu's favorite subject is " + favorite + '.',
    "She likes it because it's " + reason + '.',
    'And she also likes ' + other + '.',
  ]
}

export function introFor(interviewee: Interviewee): string {
  return 'Hello, Miss Wu. May I ask you three questions?'
}

export function closingFor(interviewee: Interviewee): string {
  return 'Thank you, Miss Wu. Please give me a moment to prepare the report.'
}

export function questionSpeech(index: number): string {
  return QUESTION_LEADS[index] + ' ' + QUESTIONS[index]
}
