import { expect, test, type Page } from '@playwright/test'

async function startInterview(page: Page) {
  await page.getByRole('button', { name: '开始采访 Miss Wu' }).click()
  const consentButton = page.getByRole('button', { name: '确认 Yes，开始第一题' })
  const firstQuestion = page.locator('.stage-copy h1', { hasText: "What's your favorite subject?" })
  const answerButton = page.getByRole('button', { name: '兜底：直接通过本题' })
  await expect.poll(async () => {
    if (await answerButton.isVisible()) return true
    if (await consentButton.isVisible()) {
      await consentButton.evaluate((button: HTMLButtonElement) => button.click()).catch(() => undefined)
    }
    return answerButton.isVisible()
  }, { timeout: 4_000 }).toBe(true)
  await expect(firstQuestion).toBeVisible()
}

test('completes Miss Wu interview and ends after the report', async ({ page }) => {
  await page.addInitScript(() => {
    const speech = window.speechSynthesis
    speech.speak = (utterance: SpeechSynthesisUtterance) => window.setTimeout(() => utterance.onend?.(new SpeechSynthesisEvent('end', { utterance })), 30)
    speech.cancel = () => undefined
    speech.pause = () => undefined
    speech.resume = () => undefined
    HTMLMediaElement.prototype.play = function () {
      const delay = this.src.includes('thank-you.wav') ? 1_400 : 30
      window.setTimeout(() => this.onended?.(new Event('ended')), delay)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
  })
  await page.goto('/?operator=1')
  const presenterImage = page.locator('.presenter-image img')
  await expect(presenterImage).toBeVisible()
  await expect.poll(() => presenterImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  await expect(page.locator('.robot-wrap')).toHaveClass(/performance-idle/)
  await expect(page.getByRole('button', { name: /Student/ })).toHaveCount(0)
  await expect(page.getByText('iPhone 彩排')).toHaveCount(0)
  await page.getByRole('button', { name: '测试声音' }).click()
  await expect(page.getByRole('button', { name: '声音已就绪' })).toBeVisible()
  await startInterview(page)
  await expect(page.locator('.robot-wrap')).toHaveClass(/performance-(listening|waiting)/)

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: '兜底：直接通过本题' }).click()
    await page.waitForTimeout(300)
  }

  const firstTeacherAnswer = page.getByRole('textbox', { name: '识别文案 1' })
  await expect(firstTeacherAnswer).toHaveValue('English')
  await expect(firstTeacherAnswer).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: '确认并开始新闻播报' }).click()
  await expect(page.getByText("Miss Wu's favorite subject is English.").first()).toBeVisible()
  await expect(page.locator('.robot-wrap')).toHaveClass(/performance-reporting/)
  await page.waitForTimeout(700)
  await expect(page.getByText("Miss Wu's favorite subject is English.").first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible()
  await expect(page.locator('.caption-bar')).toContainText('Thank you for watching AI Classroom News.')
  await expect(page.locator('.robot-wrap')).toHaveClass(/performance-thanking/)
  const finalSummary = page.locator('.report-lines.final-summary')
  await expect(finalSummary).toContainText('Hello, everyone.')
  await expect(finalSummary).toContainText("Miss Wu's favorite subject is English.")
  await expect(finalSummary).toContainText("She likes it because it's fun.")
  await expect(finalSummary).toContainText('And she also likes Chinese.')
  await page.waitForTimeout(1_000)
  await expect(finalSummary).toBeVisible()
})

test('sound test uses the bundled Microsoft Zira female audio', async ({ page }) => {
  await page.goto('/?operator=1')
  const audioResponse = page.waitForResponse((response) => response.url().endsWith('/audio/sound-ready.wav') && response.ok())
  await page.getByRole('button', { name: '测试声音' }).click()
  await audioResponse
  await expect(page.locator('.robot-wrap')).toHaveClass(/speaking/)
})

test('opening question waits for Yes before starting question one', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class ConsentRecognition {
      lang = 'en-US'; continuous = false; interimResults = true; processLocally = false
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        window.setTimeout(() => {
          const noResult = [{ transcript: 'No' }] as Array<{ transcript: string }> & { isFinal: boolean }
          noResult.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [noResult] })
        }, 150)
        window.setTimeout(() => {
          const yesResult = [{ transcript: 'Yes' }] as Array<{ transcript: string }> & { isFinal: boolean }
          yesResult.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [yesResult] })
        }, 1_200)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: ConsentRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: ConsentRecognition })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await page.getByRole('button', { name: '开始采访 Miss Wu' }).click()
  await expect(page.getByRole('heading', { name: 'May I ask you three questions?' })).toBeVisible({ timeout: 4_000 })
  await expect(page.getByText('请回答 Yes，听到肯定回答后才会开始第一题。')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible({ timeout: 4_000 })
})

test('public stage runs independently with mouse controls and can restart after completion', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
  })
  await page.goto('/')
  const stage = page.locator('.stage.fullscreen')
  await expect(page.locator('.operator-panel')).toHaveCount(0)
  await expect(page.getByText(/左键|右键/)).toHaveCount(0)

  await stage.click()
  await expect(page.getByRole('heading', { name: 'May I ask you three questions?' })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })

  await stage.click({ button: 'right' })
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: 'What other subjects do you like?' })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Preparing the report' })).toBeVisible({ timeout: 4_000 })
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible({ timeout: 4_000 })
  await expect(page.locator('.report-lines.final-summary')).toContainText("Miss Wu's favorite subject is English.")
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Ready for the interview' })).toBeVisible()
})

test('a fresh public visit ignores stale operator progress', async ({ page }) => {
  await page.goto('/?operator=1')
  await page.evaluate(() => sessionStorage.setItem('ai-classroom-news', JSON.stringify({
    phase: 'all-complete',
    currentInterviewee: 'teacher',
    questionIndex: 2,
    expectedValues: { teacher: ['English', 'fun', 'Chinese'] },
    teacher: { answers: [], reportLines: ['stale'], completed: true },
  })))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Ready for the interview' })).toBeVisible()
  await expect(page.getByText('stale')).toHaveCount(0)
})

test('operator mode is enabled only by the explicit operator=1 flag', async ({ page }) => {
  await page.goto('/?operator=false')
  await expect(page.locator('.stage.fullscreen')).toBeVisible()
  await expect(page.locator('.operator-panel')).toHaveCount(0)
  await page.goto('/?operator=1')
  await expect(page.locator('.operator-panel')).toBeVisible()
})

test('rapid double click advances only one logical stage', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
  })
  await page.goto('/')
  const stage = page.locator('.stage.fullscreen')
  await stage.dblclick({ delay: 20 })
  await expect(page.getByRole('heading', { name: 'May I ask you three questions?' })).toBeVisible()
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toHaveCount(0)
})

test('left click during the report skips to Thank you while keeping the summary', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      const delay = this.src.includes('report-') ? 10_000 : 10
      window.setTimeout(() => this.onended?.(new Event('ended')), delay)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
  })
  await page.goto('/')
  const stage = page.locator('.stage.fullscreen')
  await stage.click()
  await expect(page.getByRole('heading', { name: 'May I ask you three questions?' })).toBeVisible()
  await stage.click()
  for (const question of ["What's your favorite subject?", 'Why do you like it?', 'What other subjects do you like?']) {
    await expect(page.getByRole('heading', { name: question })).toBeVisible()
    await stage.click()
  }
  await expect(page.getByRole('heading', { name: 'Preparing the report' })).toBeVisible()
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Classroom News Report' })).toBeVisible()
  await stage.click()
  await expect(page.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible()
  await expect(page.locator('.report-lines.final-summary')).toContainText('And she also likes Chinese.')
})

test('microphone test confirms a usable input signal', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
      },
    })
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() {
        return { fftSize: 1024, getByteTimeDomainData: (data: Uint8Array) => data.fill(140) }
      }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试麦克风' }).click()
  await expect(page.getByRole('button', { name: '麦克风已就绪' })).toBeVisible({ timeout: 4_000 })
  await expect(page.getByText('麦克风已检测到声音，可以开始采访。')).toBeVisible()
})

test('speech recognition uses the first non-empty alternative without keyword matching', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class FakeRecognition {
      lang = 'en-US'
      continuous = false
      interimResults = true
      maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      onend: (() => void) | null = null
      start() {
        window.setTimeout(() => {
          const result = [{ transcript: 'Math' }, { transcript: 'English' }] as Array<{ transcript: string }> & { isFinal: boolean }
          result.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 20)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 30 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await expect(page.getByRole('button', { name: '声音已就绪' })).toBeVisible()
  await startInterview(page)
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
  await expect(page.getByText('播报预设：English')).toBeVisible()
  const savedAnswer = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ai-classroom-news') ?? '{}').teacher?.answers?.[0])
  expect(savedAnswer).toMatchObject({ transcript: 'Math', value: 'English', approved: true })
})

test('failed acknowledgement audio cannot block the next question', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      if (this.src.endsWith('/audio/thank-you.wav')) return Promise.reject(new Error('audio failed'))
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => window.setTimeout(() => utterance.onerror?.(new SpeechSynthesisErrorEvent('error', { error: 'audio-busy', utterance })), 10)
    window.speechSynthesis.cancel = () => undefined
    window.speechSynthesis.resume = () => undefined
    class Recognition {
      lang = 'en-US'; continuous = false; interimResults = true; maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        window.setTimeout(() => {
          const result = [{ transcript: 'Any answer' }] as Array<{ transcript: string }> & { isFinal: boolean }
          result.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 30)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 30 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await expect(page.getByRole('button', { name: '声音已就绪' })).toBeVisible()
  await startInterview(page)
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 5_000 })
})

test('on-device recognition shows interim and final answer text in the operator console', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class LocalRecognition {
      static available = async () => 'available'
      static install = async () => true
      lang = 'en-US'
      continuous = false
      interimResults = true
      maxAlternatives = 5
      processLocally = false
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      onend: (() => void) | null = null
      start() {
        if (!this.processLocally) throw new Error('Expected local recognition')
        window.setTimeout(() => {
          const interim = [{ transcript: 'My favorite subject is Eng' }] as Array<{ transcript: string }> & { isFinal: boolean }
          interim.isFinal = false
          this.onresult?.({ resultIndex: 0, results: [interim] })
        }, 120)
        window.setTimeout(() => {
          const finalResult = [{ transcript: 'My favorite subject is English' }] as Array<{ transcript: string }> & { isFinal: boolean }
          finalResult.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [finalResult] })
          this.onend?.()
        }, 550)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: LocalRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: LocalRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class QuietAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 30 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: QuietAudioContext })
  })
  await page.goto('/?operator=1')
  await expect(page.getByText('本机转写已就绪')).toBeVisible()
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  const answerBox = page.getByRole('textbox', { name: '识别文字' })
  await expect(answerBox).toHaveValue('My favorite subject is English', { timeout: 4_000 })
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
})

test('synchronous recognition startup failure still completes through heard-speech fallback', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { window.setTimeout(() => this.onended?.(new Event('ended')), 10); return Promise.resolve() }
    HTMLMediaElement.prototype.pause = () => undefined
    class ThrowingRecognition {
      static available = async () => 'unavailable'
      static install = async () => false
      lang = 'en-US'; continuous = false; interimResults = true; processLocally = false
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      onend: (() => void) | null = null
      start() { throw new Error('startup failed') }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: ThrowingRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: ThrowingRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 32 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 5_000 })
})

test('local language failure automatically retries online and keeps the real transcript', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { window.setTimeout(() => this.onended?.(new Event('ended')), 10); return Promise.resolve() }
    HTMLMediaElement.prototype.pause = () => undefined
    let created = 0
    class SwitchingRecognition {
      static available = async () => 'available'
      static install = async () => true
      lang = 'en-US'; continuous = false; interimResults = true; processLocally = false
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      private number = ++created
      start() {
        if (this.number === 1) {
          window.setTimeout(() => {
            const result = [{ transcript: 'Yes' }] as Array<{ transcript: string }> & { isFinal: boolean }
            result.isFinal = true
            this.onresult?.({ resultIndex: 0, results: [result] })
          }, 30)
          return
        }
        if (this.number === 2 && this.processLocally) {
          window.setTimeout(() => this.onerror?.({ error: 'language-not-supported' }), 50)
          return
        }
        if (this.processLocally) throw new Error('Online retry must disable processLocally')
        window.setTimeout(() => {
          const result = [{ transcript: 'My favorite subject is English' }] as Array<{ transcript: string }> & { isFinal: boolean }
          result.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 150)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: SwitchingRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: SwitchingRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class QuietAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 30 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: QuietAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  await expect(page.getByRole('textbox', { name: '识别文字' })).toHaveValue('My favorite subject is English', { timeout: 4_000 })
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
})

test('heard speech falls back to the preset answer when online transcription returns nothing', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class SilentRecognition {
      lang = 'en-US'
      continuous = false
      interimResults = true
      maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() { window.setTimeout(() => { this.onerror?.({ error: 'network' }); this.onend?.() }, 30) }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: SilentRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: SilentRecognition })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
    })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() {
        return {
          fftSize: 1024,
          smoothingTimeConstant: 0.35,
          getByteTimeDomainData: (data: Uint8Array) => {
            analyserRead += 1
            data.fill(analyserRead < 48 ? 145 : 128)
          },
        }
      }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await expect(page.getByRole('button', { name: '声音已就绪' })).toBeVisible()
  await startInterview(page)
  const answerBox = page.getByRole('textbox', { name: '识别文字' })
  await expect(answerBox).toHaveValue('已听到声音，正在等待回答结束…', { timeout: 4_000 })
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
  await expect(page.locator('.question-row').nth(0).locator('.approved')).toBeVisible()
  await expect(page.locator('.question-row.current')).toContainText('播报预设：fun')
})

test('microphone pause advances before a delayed transcript returns', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    let created = 0
    class SlowRecognition {
      lang = 'en-US'; continuous = false; interimResults = true; maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      private number = ++created
      start() {
        if (this.number === 1) {
          window.setTimeout(() => {
            const yes = [{ transcript: 'Yes' }] as Array<{ transcript: string }> & { isFinal: boolean }
            yes.isFinal = true
            this.onresult?.({ resultIndex: 0, results: [yes] })
          }, 30)
          return
        }
        window.setTimeout(() => {
          const interim = [{ transcript: 'My favorite subject is' }] as Array<{ transcript: string }> & { isFinal: boolean }
          interim.isFinal = false
          this.onresult?.({ resultIndex: 0, results: [interim] })
        }, 120)
        window.setTimeout(() => {
          const result = [{ transcript: 'My favorite subject is English' }] as Array<{ transcript: string }> & { isFinal: boolean }
          result.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 3_500)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: SlowRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: SlowRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 30 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_500 })
  const savedAnswer = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ai-classroom-news') ?? '{}').teacher?.answers?.[0])
  expect(savedAnswer).toMatchObject({ transcript: 'My favorite subject is', value: 'English', approved: true })
})

test('a short thinking pause does not advance before the speaker continues', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { window.setTimeout(() => this.onended?.(new Event('ended')), 10); return Promise.resolve() }
    HTMLMediaElement.prototype.pause = () => undefined
    class Recognition {
      lang = 'en-US'; continuous = false; interimResults = true; maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        window.setTimeout(() => {
          const interim = [{ transcript: 'My favorite' }] as Array<{ transcript: string }> & { isFinal: boolean }
          interim.isFinal = false
          this.onresult?.({ resultIndex: 0, results: [interim] })
        }, 150)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() {
        return {
          fftSize: 1024,
          smoothingTimeConstant: 0.35,
          getByteTimeDomainData: (data: Uint8Array) => {
            analyserRead += 1
            const firstPhrase = analyserRead < 25
            const thinkingPause = analyserRead >= 25 && analyserRead < 70
            const secondPhrase = analyserRead >= 70 && analyserRead < 95
            data.fill(firstPhrase || secondPhrase ? 145 : thinkingPause ? 128 : 128)
          },
        }
      }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  await page.waitForTimeout(1_900)
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible()
  await expect(page.locator('.question-row').nth(0).locator('.approved')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
})

test('short microphone noise does not approve the preset answer', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class SilentRecognition {
      lang = 'en-US'; continuous = false; interimResults = true; maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() { window.setTimeout(() => { this.onerror?.({ error: 'network' }); this.onend?.() }, 30) }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: SilentRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: SilentRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 8 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  await page.waitForTimeout(2_000)
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible()
  await expect(page.locator('.question-row').nth(0).locator('.approved')).toHaveCount(0)
})

test('final transcript displays immediately but only microphone silence advances', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.setTimeout(() => this.onended?.(new Event('ended')), 10)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = () => undefined
    class WrongRecognition {
      lang = 'en-US'; continuous = false; interimResults = true; maxAlternatives = 5
      onresult: ((event: unknown) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        window.setTimeout(() => {
          const result = [{ transcript: 'Math' }] as Array<{ transcript: string }> & { isFinal: boolean }
          result.isFinal = true
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 900)
      }
      abort() { this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: WrongRecognition })
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: WrongRecognition })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) } })
    let analyserRead = 0
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => undefined } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: (data: Uint8Array) => { analyserRead += 1; data.fill(analyserRead < 48 ? 145 : 128) } } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  })
  await page.goto('/?operator=1')
  await page.getByRole('button', { name: '测试声音' }).click()
  await startInterview(page)
  const answerBox = page.getByRole('textbox', { name: '识别文字' })
  await expect(answerBox).toHaveValue('Math', { timeout: 4_000 })
  await expect(page.getByRole('heading', { name: "What's your favorite subject?" })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Why do you like it?' })).toBeVisible({ timeout: 4_000 })
  await expect(page.locator('.question-row').nth(0).locator('.approved')).toBeVisible()
  const savedAnswer = await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('ai-classroom-news') ?? '{}')
    return saved.teacher?.answers?.[0]
  })
  expect(savedAnswer).toMatchObject({ transcript: 'Math', value: 'English', approved: true })
})

test('public stage remains readable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByText('Ready for the interview')).toBeVisible()
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
})

test('projection stage fits common widescreen and short projector viewports', async ({ page }) => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 900, height: 500 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.locator('.ai-presenter')).toBeVisible()
    await expect(page.locator('.caption-bar')).toBeVisible()
    const geometry = await page.evaluate(() => {
      const presenter = document.querySelector('.ai-presenter')?.getBoundingClientRect()
      const caption = document.querySelector('.caption-bar')?.getBoundingClientRect()
      const stage = document.querySelector('.stage')?.getBoundingClientRect()
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        presenter: presenter && { top: presenter.top, bottom: presenter.bottom },
        caption: caption && { top: caption.top, bottom: caption.bottom },
        stage: stage && { top: stage.top, bottom: stage.bottom },
      }
    })
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.presenter?.top).toBeGreaterThanOrEqual(0)
    expect(geometry.presenter?.bottom).toBeLessThan(geometry.caption?.top ?? 0)
    expect(geometry.caption?.bottom).toBeLessThanOrEqual(geometry.stage?.bottom ?? 0)
  }
})


