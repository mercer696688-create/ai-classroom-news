interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  processLocally?: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'
type SpeechRecognitionQuality = 'command' | 'dictation' | 'conversation'

interface SpeechRecognitionAvailabilityOptions {
  langs: string[]
  processLocally?: boolean
  quality?: SpeechRecognitionQuality
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
  available?: (options: SpeechRecognitionAvailabilityOptions) => Promise<SpeechRecognitionAvailability>
  install?: (options: SpeechRecognitionAvailabilityOptions) => Promise<boolean>
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}
