import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, CircleStop, ExternalLink, Mic, MicOff, Pause, Play,
  RefreshCcw, RotateCcw, Settings2, Sparkles, Volume2,
} from 'lucide-react'
import {
  buildReport, closingFor, createInitialState, createSession,
  introFor, questionSpeech, QUESTIONS,
} from './interview'
import type { AppState, Interviewee } from './types'

const PROMPT_RATE = 0.76
const ACK_RATE = 0.82
const REPORT_RATE = 0.72

type LocalTranscriptionStatus = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' | 'installing' | 'failed'
type StageDirection = 'next' | 'previous'

function loadState(): AppState {
  const fresh = createInitialState()
  try {
    const raw = sessionStorage.getItem('ai-classroom-news')
    if (!raw) return fresh
    const saved = JSON.parse(raw) as Partial<AppState>
    if (!saved.teacher || !saved.expectedValues) return fresh
    const recovered = { ...fresh, ...saved, expectedValues: fresh.expectedValues } as AppState
    if (recovered.currentInterviewee !== 'teacher') return fresh
    if (recovered.phase === 'needs-confirmation') {
      if (recovered.questionIndex >= QUESTIONS.length - 1) {
        recovered.phase = 'review'
        recovered.caption = 'Preparing the report'
      } else {
        recovered.questionIndex += 1
        recovered.phase = 'listening'
        recovered.caption = QUESTIONS[recovered.questionIndex]
      }
      recovered.transcript = ''
      recovered.interimTranscript = ''
    } else if (['asking', 'broadcasting'].includes(recovered.phase)) {
      recovered.phase = recovered.phase === 'broadcasting' ? 'review' : 'listening'
    }
    recovered.isRecognizing = false
    recovered.isPaused = false
    recovered.isSpeaking = false
    return recovered
  } catch {
    return fresh
  }
}

function reportFor(state: AppState, interviewee = state.currentInterviewee) {
  return state[interviewee].reportLines
}

function sessionLabel() {
  return 'Miss Wu'
}

function preferredFemaleVoice(voices: SpeechSynthesisVoice[]) {
  const englishVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'))
  const preferredNames = [/aria/i, /jenny/i, /sonia/i, /libby/i, /zira/i, /samantha/i, /karen/i, /female/i]
  return preferredNames.map((pattern) => englishVoices.find((voice) => pattern.test(voice.name))).find(Boolean)
    ?? englishVoices.find((voice) => voice.localService)
    ?? englishVoices[0]
    ?? voices[0]
    ?? null
}

function localFemaleAudio(text: string) {
  const audioByText: Record<string, string> = {
    "Hello. The AI presenter's sound is ready.": 'sound-ready.wav',
    'Hello, Miss Wu. May I ask you three questions?': 'intro.wav',
    "Question one. What's your favorite subject?": 'question-1.wav',
    'Question two. Why do you like it?': 'question-2.wav',
    'Question three. What other subjects do you like?': 'question-3.wav',
    'Thank you.': 'thank-you.wav',
    'Thank you, Miss Wu. Please give me a moment to prepare the report.': 'prepare-report.wav',
    'Hello, everyone.': 'report-hello.wav',
    "Miss Wu's favorite subject is English.": 'report-favorite.wav',
    "She likes it because it's fun.": 'report-reason.wav',
    'And she also likes Chinese.': 'report-other.wav',
    "That's the end of my report. Thank you for watching AI Classroom News.": 'final-thanks.wav',
  }
  const file = audioByText[text]
  return file ? import.meta.env.BASE_URL + 'audio/' + file : null
}

export default function App() {
  const query = new URLSearchParams(window.location.search)
  const operatorMode = query.get('operator') === '1'
  const [state, setState] = useState<AppState>(() => operatorMode ? loadState() : createInitialState())
  const [soundReady, setSoundReady] = useState(false)
  const [micStatus, setMicStatus] = useState<'idle' | 'testing' | 'ready' | 'quiet' | 'error'>('idle')
  const [localTranscriptionStatus, setLocalTranscriptionStatus] = useState<LocalTranscriptionStatus>('checking')
  const stateRef = useRef(state)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const recognitionRunRef = useRef(0)
  const recognitionRetryRef = useRef(0)
  const startRecognitionRef = useRef<(retry?: boolean) => void>(() => undefined)
  const voiceActivityCleanupRef = useRef<(() => void) | null>(null)
  const latestRecognizedTextRef = useRef('')
  const latestRecognizedAtRef = useRef(0)
  const latestRecognizedFinalRef = useRef(false)
  const consentCompletedRef = useRef(false)
  const consentListeningRef = useRef(false)
  const speechRunRef = useRef(0)
  const preferredVoiceRef = useRef<SpeechSynthesisVoice | null>(null)
  const speechStartTimerRef = useRef<number | null>(null)
  const localAudioRef = useRef<HTMLAudioElement | null>(null)
  const playbackRunRef = useRef(0)
  const transitionTimersRef = useRef<Set<number>>(new Set())
  const answerLockRef = useRef(false)
  const localTranscriptionReadyRef = useRef(false)
  const localTranscriptionPollsRef = useRef(0)

  const clearTransitions = useCallback(() => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    transitionTimersRef.current.clear()
  }, [])

  const schedule = useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      transitionTimersRef.current.delete(timer)
      callback()
    }, delay)
    transitionTimersRef.current.add(timer)
  }, [])

  const stopSpeech = useCallback(() => {
    speechRunRef.current += 1
    if (speechStartTimerRef.current !== null) {
      window.clearTimeout(speechStartTimerRef.current)
      speechStartTimerRef.current = null
    }
    let interrupted = false
    if (localAudioRef.current) {
      const audio = localAudioRef.current
      localAudioRef.current = null
      interrupted = !audio.ended
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.currentTime = 0
    }
    if ('speechSynthesis' in window) {
      const synthesis = window.speechSynthesis
      const synthesisActive = synthesis.speaking || synthesis.pending || synthesis.paused
      interrupted = interrupted || synthesisActive
      if (synthesisActive) synthesis.cancel()
    }
    setState((previous) => previous.isSpeaking ? { ...previous, isSpeaking: false, isPaused: false } : previous)
    return interrupted
  }, [])

  const speak = useCallback((text: string, onEnd?: () => void, rate = PROMPT_RATE) => {
    const interrupted = stopSpeech()
    const run = speechRunRef.current
    let completed = false
    let fallbackStarted = false
    setState((previous) => ({ ...previous, isSpeaking: true, isPaused: false }))
    const finish = () => {
      if (!completed && run === speechRunRef.current) {
        completed = true
        localAudioRef.current = null
        setState((previous) => ({ ...previous, isSpeaking: false, isPaused: false }))
        onEnd?.()
      }
    }
    const finalFail = () => {
      if (completed || run !== speechRunRef.current) return
      completed = true
      localAudioRef.current = null
      setState((previous) => ({ ...previous, isSpeaking: false, isPaused: false, warning: '声音播放失败，流程已暂停。请检查电脑和投影音响是否静音，然后点击顶部“测试声音”。' }))
    }
    const startBrowserSpeech = () => {
      if (fallbackStarted || completed || run !== speechRunRef.current) return
      fallbackStarted = true
      if (!('speechSynthesis' in window)) { finalFail(); return }
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'en-US'
      utterance.rate = rate
      utterance.pitch = 1.08
      utterance.volume = 1
      const voices = window.speechSynthesis.getVoices()
      preferredVoiceRef.current = preferredVoiceRef.current ?? preferredFemaleVoice(voices)
      if (preferredVoiceRef.current) utterance.voice = preferredVoiceRef.current
      utterance.onend = finish
      utterance.onerror = finalFail
      window.speechSynthesis.resume()
      window.speechSynthesis.speak(utterance)
    }
    const localSource = localFemaleAudio(text)
    if (localSource) {
      const audio = new Audio(localSource)
      localAudioRef.current = audio
      audio.preload = 'auto'
      audio.volume = 1
      audio.onended = finish
      const fallback = () => {
        if (fallbackStarted || completed || run !== speechRunRef.current) return
        audio.onended = null
        audio.onerror = null
        localAudioRef.current = null
        startBrowserSpeech()
      }
      audio.onerror = fallback
      const startLocalAudio = () => {
        speechStartTimerRef.current = null
        if (run !== speechRunRef.current) return
        void audio.play().catch(fallback)
      }
      if (interrupted) speechStartTimerRef.current = window.setTimeout(startLocalAudio, 80)
      else startLocalAudio()
      return true
    }
    const startSpeaking = () => {
      speechStartTimerRef.current = null
      if (run !== speechRunRef.current) return
      startBrowserSpeech()
    }
    if (interrupted) speechStartTimerRef.current = window.setTimeout(startSpeaking, 80)
    else startSpeaking()
    return true
  }, [stopSpeech])

  const stopRecognition = useCallback(() => {
    recognitionRunRef.current += 1
    voiceActivityCleanupRef.current?.()
    voiceActivityCleanupRef.current = null
    const active = recognitionRef.current
    recognitionRef.current = null
    if (active) {
      active.onresult = null
      active.onerror = null
      active.onend = null
      try { active.abort() } catch { /* already stopped */ }
    }
    setState((previous) => ({ ...previous, isRecognizing: false }))
  }, [])

  const testMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus('error')
      setState((previous) => ({ ...previous, warning: '当前浏览器无法访问麦克风，请使用 Microsoft Edge。' }))
      return
    }
    setMicStatus('testing')
    setState((previous) => ({ ...previous, warning: '请对着麦克风正常说一句 Hello…' }))
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      audioContext = new AudioContext()
      await audioContext.resume()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      let peak = 0
      const startedAt = performance.now()
      while (performance.now() - startedAt < 2200) {
        analyser.getByteTimeDomainData(data)
        for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
      }
      if (peak >= 0.025) {
        setMicStatus('ready')
        setState((previous) => ({ ...previous, warning: '麦克风已检测到声音，可以开始采访。' }))
      } else {
        setMicStatus('quiet')
        setState((previous) => ({ ...previous, warning: '麦克风已连接，但声音太小。请靠近麦克风、提高输入音量后重新测试。' }))
      }
    } catch (error) {
      setMicStatus('error')
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? '麦克风权限被阻止。请点击地址栏左侧图标，把麦克风改为“允许”，然后刷新页面。'
        : '无法读取麦克风。请检查 Windows 输入设备和 Edge 麦克风权限。'
      setState((previous) => ({ ...previous, warning: message }))
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      if (audioContext) await audioContext.close()
    }
  }, [])

  const checkLocalTranscription = useCallback(async () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Recognition?.available || !Recognition.install) {
      localTranscriptionReadyRef.current = false
      setLocalTranscriptionStatus('unsupported')
      return
    }
    setLocalTranscriptionStatus('checking')
    try {
      const availability = await Recognition.available({ langs: ['en-US'], processLocally: true, quality: 'dictation' })
      if (availability === 'downloading') {
        localTranscriptionPollsRef.current += 1
        if (localTranscriptionPollsRef.current > 20) {
          localTranscriptionReadyRef.current = false
          setLocalTranscriptionStatus('failed')
          return
        }
      } else {
        localTranscriptionPollsRef.current = 0
      }
      localTranscriptionReadyRef.current = availability === 'available'
      setLocalTranscriptionStatus(availability)
    } catch {
      localTranscriptionReadyRef.current = false
      setLocalTranscriptionStatus('unsupported')
    }
  }, [])

  const installLocalTranscription = useCallback(async () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Recognition?.install) {
      setLocalTranscriptionStatus('unsupported')
      setState((previous) => ({ ...previous, warning: '当前 Edge 版本不支持安装本机英语转写，将继续使用在线识别和讲话兜底。' }))
      return
    }
    setLocalTranscriptionStatus('installing')
    setState((previous) => ({ ...previous, warning: '正在下载本机英语转写包，请保持网络连接；通常只需安装一次。' }))
    try {
      const installed = await Recognition.install({ langs: ['en-US'], processLocally: true, quality: 'dictation' })
      if (!installed) {
        localTranscriptionReadyRef.current = false
        setLocalTranscriptionStatus('failed')
        setState((previous) => ({ ...previous, warning: '本机英语转写包暂时无法安装。仍会尝试在线显示回答文字，并保留固定答案兜底。' }))
        return
      }
      const availability = Recognition.available
        ? await Recognition.available({ langs: ['en-US'], processLocally: true, quality: 'dictation' })
        : 'available'
      const ready = availability === 'available'
      localTranscriptionReadyRef.current = ready
      setLocalTranscriptionStatus(ready ? 'available' : availability)
      setState((previous) => ({ ...previous, warning: ready ? '本机英语转写已就绪。回答时，真实文案会显示在操作台。' : '转写包仍在准备，请稍后再试。' }))
    } catch {
      localTranscriptionReadyRef.current = false
      setLocalTranscriptionStatus('failed')
      setState((previous) => ({ ...previous, warning: '安装本机英语转写失败。请确认使用最新版 Microsoft Edge 并保持网络连接。' }))
    }
  }, [])

  useEffect(() => {
    void checkLocalTranscription()
  }, [checkLocalTranscription])

  useEffect(() => {
    if (localTranscriptionStatus !== 'downloading') return
    let cancelled = false
    const poll = () => void checkLocalTranscription().finally(() => {
      if (!cancelled && !localTranscriptionReadyRef.current) window.setTimeout(poll, 3_000)
    })
    const timer = window.setTimeout(poll, 3_000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [checkLocalTranscription, localTranscriptionStatus])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const loadPreferredVoice = () => {
      preferredVoiceRef.current = preferredFemaleVoice(window.speechSynthesis.getVoices())
    }
    loadPreferredVoice()
    window.speechSynthesis.addEventListener('voiceschanged', loadPreferredVoice)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadPreferredVoice)
  }, [])

  useEffect(() => {
    stateRef.current = state
    if (operatorMode) {
      try { sessionStorage.setItem('ai-classroom-news', JSON.stringify(state)) } catch { /* optional persistence */ }
    }
  }, [operatorMode, state])

  useEffect(() => () => {
    clearTransitions()
    recognitionRunRef.current += 1
    speechRunRef.current += 1
    voiceActivityCleanupRef.current?.()
    voiceActivityCleanupRef.current = null
    const activeRecognition = recognitionRef.current
    recognitionRef.current = null
    if (activeRecognition) {
      activeRecognition.onresult = null
      activeRecognition.onerror = null
      activeRecognition.onend = null
      try { activeRecognition.abort() } catch { /* already stopped */ }
    }
    const activeAudio = localAudioRef.current
    localAudioRef.current = null
    if (activeAudio) {
      activeAudio.onended = null
      activeAudio.onerror = null
      activeAudio.pause()
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [clearTransitions])

  const finalizeInterview = useCallback(() => {
    const key = stateRef.current.currentInterviewee
    stopRecognition()
    setState((previous) => ({
      ...previous,
      phase: 'review',
      caption: closingFor(key),
      transcript: '',
      interimTranscript: '',
      warning: '',
    }))
    speak(closingFor(key))
  }, [speak, stopRecognition])

  const advanceQuestion = useCallback(() => {
    answerLockRef.current = false
    const current = stateRef.current
    if (current.questionIndex >= QUESTIONS.length - 1) {
      finalizeInterview()
      return
    }
    setState((previous) => ({
      ...previous,
      questionIndex: previous.questionIndex + 1,
      transcript: '',
      interimTranscript: '',
      warning: '',
    }))
    schedule(() => askCurrentQuestion(), 150)
  }, [finalizeInterview, schedule])

  const acceptAnswer = useCallback((transcript: string, preset = false) => {
    if (answerLockRef.current) return
    const current = stateRef.current
    const key = current.currentInterviewee
    const expected = current.expectedValues[key][current.questionIndex]
    const normalizedTranscript = transcript.trim().replace(/\s+/g, ' ')
    if (!preset && !normalizedTranscript) {
      setState((previous) => ({
        ...previous,
        transcript: '',
        interimTranscript: '',
        warning: '没有识别到回答文案，请重新收音或使用预设答案。',
        phase: 'listening',
        isRecognizing: false,
      }))
      return
    }
    const displayedTranscript = normalizedTranscript || expected
    answerLockRef.current = true
    stopRecognition()
    setState((previous) => {
      const answers = previous[key].answers.map((answer, index) => index === previous.questionIndex
        ? { transcript: displayedTranscript, value: expected, approved: true }
        : answer)
      return {
        ...previous,
        transcript: displayedTranscript,
        interimTranscript: '',
        warning: '',
        phase: 'needs-confirmation',
        caption: 'Thank you.',
        [key]: { ...previous[key], answers },
      }
    })
    let advanceQueued = false
    const advanceAfterThanks = () => {
      const latest = stateRef.current
      if (advanceQueued || latest.phase !== 'needs-confirmation' || latest.questionIndex !== current.questionIndex) return
      advanceQueued = true
      schedule(() => {
        const beforeAdvance = stateRef.current
        if (beforeAdvance.phase === 'needs-confirmation' && beforeAdvance.questionIndex === current.questionIndex) advanceQuestion()
      }, 450)
    }
    speak('Thank you.', advanceAfterThanks, ACK_RATE)
    schedule(advanceAfterThanks, 1_200)
  }, [advanceQuestion, schedule, speak, stopRecognition])

  const startVoiceActivityFallback = useCallback((
    run: number,
    onUtteranceComplete: () => void,
    options: { minimumVoiceMs?: number; silenceMs?: number; transcriptAware?: boolean } = {},
  ) => {
    if (!navigator.mediaDevices?.getUserMedia) return false
    let cancelled = false
    let samplingTimer = 0
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    const cleanup = () => {
      cancelled = true
      if (samplingTimer) {
        window.clearTimeout(samplingTimer)
        samplingTimer = 0
      }
      const activeStream = stream
      stream = null
      activeStream?.getTracks().forEach((track) => track.stop())
      const activeContext = audioContext
      audioContext = null
      if (activeContext) void activeContext.close().catch(() => undefined)
      if (voiceActivityCleanupRef.current === cleanup) voiceActivityCleanupRef.current = null
    }
    voiceActivityCleanupRef.current = cleanup
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        if (cancelled || run !== recognitionRunRef.current) { cleanup(); return }
        audioContext = new AudioContext()
        await audioContext.resume()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.35
        source.connect(analyser)
        const samples = new Uint8Array(analyser.fftSize)
        let candidateStartedAt = 0
        let voiceStartedAt = 0
        let lastVoiceAt = 0
        const listeningStartedAt = performance.now()
        const listen = () => {
          const now = performance.now()
          if (cancelled || run !== recognitionRunRef.current || answerLockRef.current) { cleanup(); return }
          analyser.getByteTimeDomainData(samples)
          let energy = 0
          for (const sample of samples) {
            const normalized = (sample - 128) / 128
            energy += normalized * normalized
          }
          const rms = Math.sqrt(energy / samples.length)
          if (rms >= 0.035) {
            if (!candidateStartedAt) candidateStartedAt = now
            if (!voiceStartedAt && now - candidateStartedAt >= 180) {
              voiceStartedAt = now
              setState((previous) => ({ ...previous, interimTranscript: '已听到声音，正在等待回答结束…', warning: '' }))
            }
            if (voiceStartedAt) lastVoiceAt = now
          } else {
            if (!voiceStartedAt) candidateStartedAt = 0
          }
          const requiredSilence = options.silenceMs ?? (latestRecognizedFinalRef.current ? 900 : 1_600)
          const completedUtterance = voiceStartedAt > 0 &&
            lastVoiceAt - voiceStartedAt >= (options.minimumVoiceMs ?? 350) &&
            now - lastVoiceAt >= requiredSilence &&
            (options.transcriptAware === false || !latestRecognizedTextRef.current.trim() || now - latestRecognizedAtRef.current >= 350)
          const maximumUtteranceReached = voiceStartedAt > 0 && lastVoiceAt - voiceStartedAt >= 700 && now - listeningStartedAt >= 10_000
          if (completedUtterance || maximumUtteranceReached) {
            cleanup()
            onUtteranceComplete()
            return
          }
          if (!voiceStartedAt && now - listeningStartedAt >= 12_000) {
            cleanup()
            setState((previous) => ({ ...previous, isRecognizing: Boolean(recognitionRef.current), interimTranscript: '', warning: '暂时没有听到回答，请靠近麦克风后点击“重新收音”，或由工作人员直接通过本题。' }))
            return
          }
          samplingTimer = window.setTimeout(listen, 30)
        }
        samplingTimer = window.setTimeout(listen, 30)
      } catch (error) {
        cleanup()
        if (run !== recognitionRunRef.current) return
        const denied = error instanceof DOMException && error.name === 'NotAllowedError'
        const recognitionStillActive = Boolean(recognitionRef.current)
        setState((previous) => ({
          ...previous,
          isRecognizing: recognitionStillActive,
          warning: denied
            ? '麦克风权限被阻止，请点击地址栏左侧图标允许麦克风。'
            : '无法读取麦克风，请检查 Windows 输入设备后点击“重新收音”。',
        }))
      }
    })()
    return true
  }, [])

  const startRecognition = useCallback((retry = false) => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    stopRecognition()
    if (!retry) recognitionRetryRef.current = 0
    answerLockRef.current = false
    const run = recognitionRunRef.current
    const questionIndex = stateRef.current.questionIndex
    const expected = stateRef.current.expectedValues[stateRef.current.currentInterviewee][questionIndex]
    latestRecognizedTextRef.current = ''
    latestRecognizedAtRef.current = 0
    latestRecognizedFinalRef.current = false
    let receivedFinalText = false
    const activityAvailable = startVoiceActivityFallback(run, () => {
      if (run !== recognitionRunRef.current || stateRef.current.phase !== 'listening' || stateRef.current.questionIndex !== questionIndex) return
      const recognizedText = latestRecognizedTextRef.current.trim()
      acceptAnswer(recognizedText || expected, !recognizedText)
    })
    setState((previous) => ({
      ...previous,
      phase: 'listening',
      recognitionSupported: Boolean(Recognition),
      isRecognizing: activityAvailable || Boolean(Recognition),
      transcript: '',
      interimTranscript: '',
      warning: Recognition ? '' : (activityAvailable ? '在线文字识别不可用，已启用讲话检测；说完后会使用本题预设答案继续。' : '当前浏览器无法使用麦克风，请由工作人员直接通过本题。'),
      caption: QUESTIONS[previous.questionIndex],
    }))
    if (!Recognition) return
    const recognition = new Recognition()
    let runningLocally = localTranscriptionReadyRef.current
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = true
    if ('processLocally' in recognition) recognition.processLocally = runningLocally
    ;(recognition as SpeechRecognition & { maxAlternatives?: number }).maxAlternatives = 5
    let lastError = ''
    recognition.onresult = (event) => {
      if (run !== recognitionRunRef.current || answerLockRef.current) return
      const finalChunks: string[] = []
      const interimChunks: string[] = []
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) {
          const alternatives = Array.from(result).map((alternative) => alternative.transcript.trim()).filter(Boolean)
          const selected = alternatives[0] ?? ''
          if (selected) finalChunks.push(selected)
        }
        else {
          const chunk = result[0].transcript.trim()
          if (chunk) interimChunks.push(chunk)
        }
      }
      const finalText = finalChunks.join(' ')
      const interimText = interimChunks.join(' ')
      if (interimText.trim()) {
        latestRecognizedTextRef.current = interimText.trim()
        latestRecognizedAtRef.current = performance.now()
        latestRecognizedFinalRef.current = false
      }
      setState((previous) => ({
        ...previous,
        interimTranscript: interimText.trim() ? interimText.trim() : previous.interimTranscript,
        warning: interimText.trim() ? '' : previous.warning,
      }))
      if (finalText.trim()) {
        receivedFinalText = true
        latestRecognizedTextRef.current = finalText.trim()
        latestRecognizedAtRef.current = performance.now()
        latestRecognizedFinalRef.current = true
        setState((previous) => ({
          ...previous,
          transcript: finalText.trim(),
          interimTranscript: '',
          warning: '',
        }))
      }
    }
    recognition.onerror = (event) => {
      if (run !== recognitionRunRef.current) return
      lastError = event.error
      recognitionRef.current = null
      if (event.error === 'language-not-supported' && runningLocally) {
        const handleResult = recognition.onresult
        const handleEnd = recognition.onend
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        localTranscriptionReadyRef.current = false
        setLocalTranscriptionStatus('failed')
        runningLocally = false
        setState((previous) => ({ ...previous, isRecognizing: true, warning: '本机英语转写暂时不可用，正在自动切换到在线转写…' }))
        const onlineRecognition = new Recognition()
        onlineRecognition.lang = 'en-US'
        onlineRecognition.continuous = false
        onlineRecognition.interimResults = true
        if ('processLocally' in onlineRecognition) onlineRecognition.processLocally = false
        ;(onlineRecognition as SpeechRecognition & { maxAlternatives?: number }).maxAlternatives = 5
        onlineRecognition.onresult = handleResult
        onlineRecognition.onerror = (onlineError) => {
          if (run !== recognitionRunRef.current) return
          lastError = onlineError.error
          recognitionRef.current = null
          const fallbackActive = Boolean(voiceActivityCleanupRef.current)
          setState((previous) => ({ ...previous, phase: 'listening', isRecognizing: fallbackActive, warning: fallbackActive ? '转写没有返回，但不影响流程；说完停顿后会立即进入下一题。' : '在线识别未能启动，请点击“重新收音”或直接通过本题。' }))
        }
        onlineRecognition.onend = handleEnd
        recognitionRef.current = onlineRecognition
        try { onlineRecognition.start() } catch {
          recognitionRef.current = null
          const fallbackActive = Boolean(voiceActivityCleanupRef.current)
          setState((previous) => ({ ...previous, isRecognizing: fallbackActive, warning: fallbackActive ? '转写未启动，但麦克风仍在听；说完停顿后会立即进入下一题。' : '在线转写无法启动，请重新收音或直接通过本题。' }))
        }
        return
      }
      const fallbackActive = Boolean(voiceActivityCleanupRef.current)
      setState((previous) => ({
        ...previous,
        phase: 'listening',
        isRecognizing: fallbackActive,
        warning: event.error === 'language-not-supported'
          ? '本机英语转写暂时不可用，已改用讲话检测和预设答案兜底。'
          : fallbackActive
          ? '文字转写暂时没有返回，但不影响流程；说完停顿后会立即进入下一题。'
          : event.error === 'not-allowed'
            ? '麦克风权限未开启，请允许权限后重新测试麦克风。'
            : event.error === 'audio-capture'
              ? '没有找到可用麦克风，请检查 Windows 输入设备。'
              : event.error === 'network'
                ? '在线语音识别服务连接失败，请检查网络后点击“重新收音”。'
                : '没有听清楚，系统会自动再听一次。',
      }))
    }
    recognition.onend = () => {
      if (run !== recognitionRunRef.current) return
      recognitionRef.current = null
      const fallbackActive = Boolean(voiceActivityCleanupRef.current)
      setState((previous) => ({ ...previous, isRecognizing: fallbackActive }))
      const canRetry = !receivedFinalText &&
        stateRef.current.phase === 'listening' &&
        stateRef.current.autoListen &&
        !fallbackActive &&
        recognitionRetryRef.current < 2 &&
        !['not-allowed', 'audio-capture', 'network'].includes(lastError)
      if (canRetry) {
        recognitionRetryRef.current += 1
        schedule(() => startRecognitionRef.current(true), 250)
      }
    }
    recognitionRef.current = recognition
    try { recognition.start() } catch {
      recognitionRef.current = null
      const fallbackActive = Boolean(voiceActivityCleanupRef.current)
      setState((previous) => ({
        ...previous,
        phase: 'listening',
        isRecognizing: fallbackActive,
        warning: fallbackActive ? '文字转写未启动，但麦克风仍在听；说完停顿后会立即进入下一题。' : '麦克风暂时无法启动，请重试或使用预设答案。',
      }))
    }
  }, [acceptAnswer, schedule, startVoiceActivityFallback, stopRecognition])
  startRecognitionRef.current = startRecognition

  const askCurrentQuestion = useCallback(() => {
    stopRecognition()
    answerLockRef.current = false
    const speech = questionSpeech(stateRef.current.questionIndex)
    setState((previous) => ({ ...previous, phase: 'asking', caption: speech, transcript: '', interimTranscript: '', warning: '' }))
    const after = () => stateRef.current.autoListen
      ? startRecognition()
      : setState((previous) => ({ ...previous, phase: 'listening', isRecognizing: false, caption: QUESTIONS[previous.questionIndex] }))
    if (!speak(speech, after)) after()
  }, [speak, startRecognition, stopRecognition])

  const confirmConsent = useCallback((force = false) => {
    if (consentCompletedRef.current && !force) return
    consentCompletedRef.current = true
    consentListeningRef.current = false
    clearTransitions()
    stopRecognition()
    setState((previous) => ({
      ...previous,
      phase: 'asking',
      isRecognizing: false,
      transcript: 'Yes',
      interimTranscript: '',
      warning: '',
      caption: 'Thank you. Let us begin.',
    }))
    schedule(askCurrentQuestion, 450)
  }, [askCurrentQuestion, clearTransitions, schedule, stopRecognition])

  const startConsentListening = useCallback(() => {
    if (consentCompletedRef.current || consentListeningRef.current) return
    consentListeningRef.current = true
    stopRecognition()
    answerLockRef.current = false
    latestRecognizedTextRef.current = ''
    latestRecognizedAtRef.current = 0
    latestRecognizedFinalRef.current = false
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    setState((previous) => ({
      ...previous,
      phase: 'awaiting-consent',
      recognitionSupported: Boolean(Recognition),
      isRecognizing: Boolean(Recognition),
      transcript: '',
      interimTranscript: '',
      warning: Recognition ? '' : '当前浏览器无法识别 Yes，请由工作人员点击确认。',
      caption: 'Please answer, Yes.',
    }))
    if (!Recognition) return
    const recognition = new Recognition()
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = true
    if ('processLocally' in recognition) recognition.processLocally = localTranscriptionReadyRef.current
    const isAffirmative = (text: string) => /\b(?:yes|yeah|yep|sure|ok|okay)\b/i.test(text)
    recognition.onresult = (event) => {
      const chunks: string[] = []
      let hasFinal = false
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const chunk = result[0]?.transcript?.trim() ?? ''
        if (chunk) chunks.push(chunk)
        hasFinal = hasFinal || result.isFinal
      }
      const text = chunks.join(' ').trim()
      if (!text) return
      setState((previous) => ({
        ...previous,
        transcript: hasFinal ? text : previous.transcript,
        interimTranscript: hasFinal ? '' : text,
        warning: isAffirmative(text) ? '' : '请回答 Yes，听到肯定回答后才会开始第一题。',
      }))
      if (isAffirmative(text)) confirmConsent()
    }
    recognition.onerror = () => {
      recognitionRef.current = null
      consentListeningRef.current = false
      setState((previous) => previous.phase === 'awaiting-consent'
        ? { ...previous, isRecognizing: false, warning: '没有听清 Yes，请点击“重新听 Yes”再试一次。' }
        : previous)
    }
    recognition.onend = () => {
      recognitionRef.current = null
      consentListeningRef.current = false
      setState((previous) => previous.phase === 'awaiting-consent'
        ? { ...previous, isRecognizing: false, warning: previous.warning || '没有听清 Yes，请点击“重新听 Yes”再试一次。' }
        : previous)
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      consentListeningRef.current = false
      setState((previous) => ({ ...previous, isRecognizing: false, warning: 'Yes 识别未启动，请点击“重新听 Yes”或由工作人员确认。' }))
    }
  }, [confirmConsent, stopRecognition])

  const startRound = useCallback(() => {
    const interviewee: Interviewee = 'teacher'
    const current = stateRef.current
    if (current.teacher.answers.some((answer) => answer.approved) && !window.confirm('确定重新开始 Miss Wu 的采访吗？旧答案和播报将被清空。')) return
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    consentCompletedRef.current = false
    consentListeningRef.current = false
    setState((previous) => ({
      ...previous,
      currentInterviewee: interviewee,
      questionIndex: 0,
      transcript: '',
      interimTranscript: '',
      warning: '',
      phase: 'asking',
      caption: introFor(interviewee),
      [interviewee]: createSession(interviewee),
    }))
    if (!speak(introFor(interviewee), startConsentListening)) {
      startConsentListening()
    }
  }, [clearTransitions, speak, startConsentListening, stopRecognition, stopSpeech])

  const playReport = useCallback(() => {
    const current = stateRef.current
    const key = current.currentInterviewee
    const lines = buildReport(key, current.expectedValues[key])
    clearTransitions()
    stopRecognition()
    stopSpeech()
    playbackRunRef.current += 1
    const run = playbackRunRef.current
    setState((previous) => ({
      ...previous,
      phase: 'broadcasting',
      isPaused: false,
      caption: lines[0],
      warning: '',
      [key]: { ...previous[key], reportLines: lines },
    }))
    let lineIndex = 0
    const speakLine = () => {
      if (run !== playbackRunRef.current) return
      if (lineIndex >= lines.length) {
        const closing = "That's the end of my report. Thank you for watching AI Classroom News."
        setState((previous) => ({ ...previous, caption: closing, [key]: { ...previous[key], completed: true } }))
        speak(closing, () => setState((previous) => ({ ...previous, phase: 'all-complete', caption: 'Thank you for watching AI Classroom News.' })), ACK_RATE)
        return
      }
      setState((previous) => ({ ...previous, caption: lines[lineIndex] }))
      const started = speak(lines[lineIndex], () => {
        if (run !== playbackRunRef.current) return
        lineIndex += 1
        speakLine()
      }, REPORT_RATE)
      if (!started) setState((previous) => ({ ...previous, phase: 'review', caption: lines[0] }))
    }
    speakLine()
  }, [clearTransitions, speak, stopRecognition, stopSpeech])

  const pauseOrResume = useCallback(() => {
    const localAudio = localAudioRef.current
    if (localAudio && !localAudio.ended) {
      if (localAudio.paused) {
        void localAudio.play().then(() => {
          setState((previous) => ({ ...previous, isPaused: false }))
        }).catch(() => setState((previous) => ({ ...previous, warning: '无法继续播放声音，请点击“重新播报”。' })))
      } else {
        localAudio.pause()
        setState((previous) => ({ ...previous, isPaused: true }))
      }
      return
    }
    if (!('speechSynthesis' in window)) return
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume()
      setState((previous) => ({ ...previous, isPaused: false }))
    } else {
      window.speechSynthesis.pause()
      setState((previous) => ({ ...previous, isPaused: true }))
    }
  }, [])

  const emergencyStop = useCallback(() => {
    const current = stateRef.current
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    setState((previous) => {
      let phase = previous.phase
      if (previous.phase === 'broadcasting') phase = 'review'
      if (previous.phase === 'asking' || previous.phase === 'needs-confirmation') {
        phase = 'listening'
      }
      return { ...previous, phase, caption: phase === 'listening' ? QUESTIONS[current.questionIndex] : previous.caption, isPaused: false, isRecognizing: false, warning: '已紧急停止。已保留识别文案，流程不会自动继续，请由工作人员选择下一步。' }
    })
  }, [clearTransitions, stopRecognition, stopSpeech])

  const resetAll = useCallback(() => {
    const hasData = stateRef.current.teacher.answers.some((answer) => answer.approved)
    if (hasData && !window.confirm('确定清空本场所有采访数据并重新开始吗？')) return
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    sessionStorage.removeItem('ai-classroom-news')
    setState(createInitialState())
  }, [clearTransitions, stopRecognition, stopSpeech])

  const returnToWelcome = useCallback(() => {
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    consentCompletedRef.current = false
    consentListeningRef.current = false
    setState((previous) => ({ ...createInitialState(), autoListen: previous.autoListen }))
  }, [clearTransitions, stopRecognition, stopSpeech])

  const returnToOpening = useCallback(() => {
    const interviewee: Interviewee = 'teacher'
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    consentCompletedRef.current = false
    consentListeningRef.current = false
    setState((previous) => ({
      ...previous,
      currentInterviewee: interviewee,
      questionIndex: 0,
      transcript: '',
      interimTranscript: '',
      warning: '',
      phase: 'asking',
      caption: introFor(interviewee),
      [interviewee]: createSession(interviewee),
    }))
    if (!speak(introFor(interviewee), startConsentListening)) startConsentListening()
  }, [clearTransitions, speak, startConsentListening, stopRecognition, stopSpeech])

  const returnToQuestion = useCallback((questionIndex: number) => {
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    consentCompletedRef.current = true
    consentListeningRef.current = false
    setState((previous) => ({
      ...previous,
      questionIndex,
      transcript: '',
      interimTranscript: '',
      warning: '',
      phase: 'asking',
      caption: questionSpeech(questionIndex),
      teacher: {
        ...previous.teacher,
        completed: false,
        reportLines: [],
        answers: previous.teacher.answers.map((answer, index) => index < questionIndex
          ? answer
          : { transcript: '', value: previous.expectedValues.teacher[index], approved: false }),
      },
    }))
    schedule(askCurrentQuestion, 120)
  }, [askCurrentQuestion, clearTransitions, schedule, stopRecognition, stopSpeech])

  const returnToReview = useCallback(() => {
    clearTransitions()
    playbackRunRef.current += 1
    stopRecognition()
    stopSpeech()
    answerLockRef.current = false
    setState((previous) => ({
      ...previous,
      phase: 'review',
      isPaused: false,
      isRecognizing: false,
      caption: closingFor(previous.currentInterviewee),
      [previous.currentInterviewee]: { ...previous[previous.currentInterviewee], completed: false },
    }))
  }, [clearTransitions, stopRecognition, stopSpeech])

  const navigateStage = useCallback((direction: StageDirection) => {
    const current = stateRef.current
    const openingPrompt = current.phase === 'asking' && current.caption === introFor(current.currentInterviewee)
    if (direction === 'next') {
      if (current.phase === 'welcome') { startRound(); return }
      if (openingPrompt) { clearTransitions(); stopSpeech(); startConsentListening(); return }
      if (current.phase === 'awaiting-consent') { confirmConsent(true); return }
      if (current.phase === 'asking') {
        clearTransitions()
        stopSpeech()
        acceptAnswer(current.expectedValues.teacher[current.questionIndex], true)
        return
      }
      if (current.phase === 'listening') {
        const interim = /^[A-Za-z]/.test(current.interimTranscript.trim()) ? current.interimTranscript.trim() : ''
        const heard = current.transcript.trim() || interim
        acceptAnswer(heard || current.expectedValues.teacher[current.questionIndex], !heard)
        return
      }
      if (current.phase === 'needs-confirmation') {
        clearTransitions()
        stopSpeech()
        advanceQuestion()
        return
      }
      if (current.phase === 'review') playReport()
      if (current.phase === 'broadcasting') {
        clearTransitions()
        playbackRunRef.current += 1
        stopSpeech()
        setState((previous) => ({
          ...previous,
          phase: 'all-complete',
          caption: 'Thank you for watching AI Classroom News.',
          [previous.currentInterviewee]: { ...previous[previous.currentInterviewee], completed: true },
        }))
      }
      if (current.phase === 'all-complete') returnToWelcome()
      return
    }

    if (current.phase === 'welcome') return
    if (openingPrompt || current.phase === 'awaiting-consent') { returnToWelcome(); return }
    if (['asking', 'listening', 'needs-confirmation'].includes(current.phase)) {
      if (current.questionIndex > 0) returnToQuestion(current.questionIndex - 1)
      else returnToOpening()
      return
    }
    if (current.phase === 'review') { returnToQuestion(QUESTIONS.length - 1); return }
    if (current.phase === 'broadcasting' || current.phase === 'all-complete' || current.phase === 'round-complete') returnToReview()
  }, [
    acceptAnswer, advanceQuestion, clearTransitions, confirmConsent, playReport, returnToOpening,
    returnToQuestion, returnToReview, returnToWelcome, startConsentListening, startRecognition,
    startRound, stopSpeech,
  ])
  const expected = state.expectedValues[state.currentInterviewee][state.questionIndex]
  const currentSession = state[state.currentInterviewee]
  const activeRound = !['welcome', 'round-complete', 'all-complete'].includes(state.phase)
  const awaitingConsent = state.phase === 'awaiting-consent'
  const localStatusLabel = localTranscriptionStatus === 'available'
    ? '本机转写已就绪'
    : localTranscriptionStatus === 'installing' || localTranscriptionStatus === 'downloading'
      ? '正在准备本机转写'
      : localTranscriptionStatus === 'checking'
        ? '正在检查转写能力'
        : '在线转写 + 讲话兜底'
  const canInstallLocalTranscription = localTranscriptionStatus === 'downloadable' || localTranscriptionStatus === 'failed'
  const canRecheckLocalTranscription = localTranscriptionStatus === 'unavailable' || localTranscriptionStatus === 'unsupported'

  if (!operatorMode) return <Stage state={state} onNavigate={navigateStage} />

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Sparkles size={18} /></span><div><strong>AI Classroom News</strong><span>现场采访控制台</span></div></div>
        <div className="top-actions">
          <span className={localTranscriptionStatus === 'available' ? 'status ok' : 'status warn'}><span />{localStatusLabel}</span>
          <button className="secondary" onClick={() => window.open(window.location.pathname, 'ai-stage')}><ExternalLink size={16} />打开演示页</button>
          {state.phase === 'welcome' && <button className={soundReady ? 'safe' : 'secondary'} onClick={() => speak("Hello. The AI presenter's sound is ready.", () => setSoundReady(true), ACK_RATE)}><Volume2 size={16} />{soundReady ? '声音已就绪' : '测试声音'}</button>}
          {state.phase === 'welcome' && <button className={micStatus === 'ready' ? 'safe' : 'secondary'} onClick={() => void testMicrophone()}><Mic size={16} />{micStatus === 'testing' ? '请说 Hello…' : micStatus === 'ready' ? '麦克风已就绪' : '测试麦克风'}</button>}
          {state.phase === 'welcome' && localTranscriptionStatus !== 'available' && <button className="secondary" disabled={!canInstallLocalTranscription && !canRecheckLocalTranscription} onClick={() => void (canInstallLocalTranscription ? installLocalTranscription() : checkLocalTranscription())}><Mic size={16} />{localTranscriptionStatus === 'installing' || localTranscriptionStatus === 'downloading' ? '正在准备英语转写…' : localTranscriptionStatus === 'checking' ? '正在检查转写…' : canInstallLocalTranscription ? '安装本机英语转写' : '重新检查本机转写'}</button>}
          <button className="icon-button" aria-label="重置全部" onClick={resetAll}><RefreshCcw size={18} /></button>
        </div>
      </header>

      <section className="workspace">
        <div className="stage-card"><Stage state={state} embedded onNavigate={navigateStage} /></div>
        <aside className="operator-panel">
          <div className="panel-heading"><div><span className="eyebrow">CURRENT SESSION</span><h2>{sessionLabel()}</h2></div><div className="step-pill">{state.phase === 'welcome' ? '准备' : awaitingConsent ? '确认' : Math.min(state.questionIndex + 1, 3) + ' / 3'}</div></div>

          <div className="round-switch">
            <button className="active single-participant" onClick={startRound} disabled={activeRound}><span>01</span>Miss Wu {state.teacher.completed && <Check size={15} />}</button>
          </div>

          <div className="auto-flow-guide">
            <Sparkles size={17} />
            <div><strong>{awaitingConsent ? '正在识别 Miss Wu 是否回答 Yes' : state.autoListen ? '短暂停顿会继续听，确认说完后再进入下一题' : '自动开麦已关闭，请手动开始收音'}</strong><span>{awaitingConsent ? '只有识别到 Yes、Yeah、Yep、OK 或 Sure，数字人才会开始 Question 1。' : state.autoListen ? '完整转写后停顿约 0.9 秒；只有半句或无转写时会等待约 1.6 秒，避免讲话中途跳题。' : '点击下方“开始收音”；确认说完后会完成本题。'}</span></div>
          </div>

          <section className="control-section">
            <div className="section-title"><Settings2 size={16} /><span>问题与预设答案</span></div>
            <div className="question-list">
              {QUESTIONS.map((question, index) => <div className={'question-row ' + (index === state.questionIndex && activeRound && !awaitingConsent ? 'current' : '')} key={question}><span className="number">{index + 1}</span><div><strong>{question}</strong><small>播报预设：{state.expectedValues[state.currentInterviewee][index]}</small></div>{currentSession.answers[index].approved && <Check className="approved" size={17} />}</div>)}
            </div>
          </section>

          {state.phase === 'all-complete' ? (
            <section className="control-section completion-card"><div className="section-title"><Check size={16} /><span>整场活动已完成</span></div><p>Miss Wu 的采访和新闻播报已结束。投影将继续保留完整播报内容。</p></section>
          ) : state.phase !== 'review' ? (
            <section className="control-section transcript-box">
              <div className="section-title">{state.isRecognizing ? <Mic className="recording" size={16} /> : <MicOff size={16} />}<span>{state.isRecognizing ? '正在听回答并显示文案…' : '回答文案'}</span><label className="auto-label"><input aria-label="自动开麦" type="checkbox" checked={state.autoListen} onChange={(event) => setState((previous) => ({ ...previous, autoListen: event.target.checked }))} />自动开麦</label></div>
              <textarea aria-label="识别文字" value={state.interimTranscript || state.transcript} placeholder={awaitingConsent ? '请回答 Yes，系统听到后会开始第一题。' : '回答时，这里会实时显示识别到的英文文案。'} onChange={(event) => setState((previous) => ({ ...previous, transcript: event.target.value, interimTranscript: '' }))} />
              <div className="keyword-line"><span>{awaitingConsent ? '开场确认' : '播报预设'}</span><strong>{awaitingConsent ? 'Yes' : expected}</strong></div>
              {state.warning && <p className="warning">{state.warning}</p>}
            </section>
          ) : (
            <section className="control-section answer-review">
              <div className="section-title"><Check size={16} /><span>确认三个答案后直接播报</span></div>
              {QUESTIONS.map((question, index) => <label key={question}><span>{index + 1}. {question}（播报预设：{state.expectedValues[state.currentInterviewee][index]}）</span><input aria-label={'识别文案 ' + (index + 1)} value={currentSession.answers[index].transcript} readOnly /></label>)}
              {state.warning && <p className="warning">{state.warning}</p>}
              {currentSession.reportLines.length > 0 && <div className="report-preview">{currentSession.reportLines.map((line) => <p key={line}>{line}</p>)}</div>}
            </section>
          )}

          <div className="control-grid">
            {state.phase === 'welcome' && !soundReady && <p className="sound-gate wide"><Volume2 size={16} />请先点击右上角“测试声音”，听到女声后再开始采访。</p>}
            {state.phase === 'welcome' && <button className="primary wide" onClick={startRound} disabled={!soundReady}><Play size={18} />开始采访 Miss Wu</button>}
            {awaitingConsent && !state.isRecognizing && <button className="primary" onClick={startConsentListening}><Mic size={18} />重新听 Yes</button>}
            {awaitingConsent && <button className="safe wide" onClick={() => confirmConsent(true)}><Check size={18} />确认 Yes，开始第一题</button>}
            {state.phase === 'listening' && !state.isRecognizing && <button className="primary" onClick={() => startRecognition()}><Mic size={18} />{state.autoListen ? '没听清，重新收音' : '开始收音'}</button>}
            {state.phase === 'listening' && <button className="safe" onClick={() => acceptAnswer(expected, true)}><Check size={18} />兜底：直接通过本题</button>}
            {state.phase === 'listening' && !state.isRecognizing && <button className="secondary wide" onClick={askCurrentQuestion}><RotateCcw size={18} />重播当前问题</button>}
            {state.phase === 'listening' && state.transcript.trim() && <button className="secondary wide" onClick={() => acceptAnswer(state.transcript)}><Check size={18} />使用当前文案并继续</button>}
            {state.phase === 'review' && <button className="primary wide" onClick={playReport}><Sparkles size={18} />确认并开始新闻播报</button>}
            {state.phase === 'broadcasting' && <button className="primary" onClick={pauseOrResume}>{state.isPaused ? <Play size={18} /> : <Pause size={18} />}{state.isPaused ? '继续' : '暂停'}</button>}
            {state.phase === 'broadcasting' && <button className="secondary" onClick={playReport}><RotateCcw size={18} />重新播报</button>}
            {!['welcome', 'all-complete'].includes(state.phase) && <button className="danger-link wide" onClick={emergencyStop}><CircleStop size={16} />紧急停止声音和收音</button>}
          </div>
        </aside>
      </section>
    </main>
  )
}

function stageCopy(state: AppState) {
  if (state.phase === 'welcome') return { kicker: 'READY', title: 'Ready for the interview', header: 'Ready' }
  if (state.phase === 'asking' && state.caption === introFor(state.currentInterviewee)) return { kicker: 'OPENING QUESTION', title: 'May I ask you three questions?', header: 'Opening' }
  if (state.phase === 'awaiting-consent') return { kicker: 'YOUR ANSWER', title: 'May I ask you three questions?', header: 'Waiting for Yes' }
  if (state.phase === 'review') return { kicker: 'ANSWER REVIEW', title: 'Preparing the report', header: 'Review' }
  if (state.phase === 'broadcasting') return { kicker: 'NEWS REPORT', title: 'Classroom News Report', header: 'Live report' }
  if (state.phase === 'round-complete') return { kicker: 'REPORT COMPLETE', title: 'Thank you', header: 'Complete' }
  if (state.phase === 'all-complete') return { kicker: 'AI CLASSROOM NEWS', title: 'Thank you!', header: 'Complete' }
  const questionNumber = state.questionIndex + 1
  const answering = state.phase === 'listening' || state.phase === 'needs-confirmation'
  const askingQuestion = state.phase === 'asking' && state.caption === questionSpeech(state.questionIndex)
  return { kicker: answering ? 'YOUR ANSWER' : askingQuestion ? 'QUESTION ' + questionNumber : 'LIVE INTERVIEW', title: QUESTIONS[state.questionIndex], header: 'Question ' + questionNumber }
}

function reportLineContent(line: string, highlightKeywords: boolean) {
  if (!highlightKeywords) return line
  return line.split(/(English|fun|Chinese)/g).map((part, index) =>
    /^(English|fun|Chinese)$/.test(part)
      ? <span className="report-keyword" key={part + index}>{part}</span>
      : part,
  )
}

function Stage({ state, embedded = false, onNavigate }: { state: AppState; embedded?: boolean; onNavigate?: (direction: StageDirection) => void }) {
  const reportLines = useMemo(() => reportFor(state), [state])
  const speaking = state.isSpeaking && !state.isPaused
  const performance = state.isRecognizing
    ? 'listening'
    : state.phase === 'listening' || state.phase === 'awaiting-consent'
      ? 'waiting'
    : state.phase === 'broadcasting'
      ? 'reporting'
      : state.phase === 'asking' || state.phase === 'needs-confirmation'
        ? 'presenting'
        : state.phase === 'all-complete'
          ? 'thanking'
          : state.phase === 'review'
            ? 'thinking'
            : 'idle'
  const copy = stageCopy(state)
  return (
    <section
      className={'stage ' + (embedded ? 'embedded' : 'fullscreen') + (state.phase === 'all-complete' ? ' final-layout' : '')}
      onClick={(event) => { if (event.detail <= 1) onNavigate?.('next') }}
      onContextMenu={(event) => { event.preventDefault(); onNavigate?.('previous') }}
    >
      <div className="stage-grid" />
      <div className="stage-ambient ambient-one" /><div className="stage-ambient ambient-two" />
      <div className="stage-header"><div className="live-badge"><span />AI CLASSROOM NEWS</div><div>{sessionLabel()} · {copy.header}</div></div>
      <div className="stage-content">
        <div className={'robot-wrap performance-' + performance + (speaking ? ' speaking' : '')}>
          <div className="robot-scale">
            <div className="signal-ring ring-one" /><div className="signal-ring ring-two" />
            <div className="ai-presenter presenter-image">
              <div className="presenter-image-glow" />
              <div className="presenter-image-fallback" aria-hidden="true"><Sparkles size={76} /></div>
              <img src={import.meta.env.BASE_URL + 'presenter-female-ai-v2.png'} alt="" aria-hidden="true" />
              <div className="presenter-speaking-light" />
            </div>
          </div>
          {state.isRecognizing && <div className="listening-orbit"><Mic size={20} /><span>LISTENING</span></div>}
          <div className="performance-label"><span />{performance === 'listening' ? 'Listening carefully' : performance === 'waiting' ? 'Waiting for Miss Wu' : performance === 'reporting' ? 'News presenter mode' : performance === 'presenting' ? 'Speaking to Miss Wu' : performance === 'thinking' ? 'Preparing the report' : performance === 'thanking' ? 'Thank you' : 'Ready'}</div>
        </div>
        <div className="stage-copy"><span className="stage-kicker">{copy.kicker}</span><h1>{copy.title}</h1>{['broadcasting', 'review', 'round-complete', 'all-complete'].includes(state.phase) && reportLines.length > 0 && <div className={'report-lines ' + (state.phase === 'all-complete' ? 'final-summary' : '')}>{reportLines.map((line) => <p className={line === state.caption ? 'active' : ''} key={line}>{reportLineContent(line, state.phase === 'all-complete')}</p>)}</div>}{state.isRecognizing && <div className="sound-wave">{Array.from({ length: 18 }).map((_, index) => <span key={index} />)}</div>}</div>
      </div>
      <div className="caption-bar" role="status" aria-live="polite"><span className="caption-label">AI</span><p>{state.caption}</p></div>
    </section>
  )
}
