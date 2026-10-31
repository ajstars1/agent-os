// Gemini on Vertex from this PC, through Ayush's own gcloud login (no key stored). Used as the fallback brain
// when Claude is at its usage limit. aos-cloud has its own copy with a service account (cloud/bot.ts).
import { spawnSync } from 'node:child_process'

const PROJECT = process.env.VERTEX_PROJECT ?? ''
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const TOKEN_TTL_MS = 45 * 60_000

let token: { value: string; at: number } | null = null
const accessToken = (): string => {
  if (token && Date.now() - token.at < TOKEN_TTL_MS) return token.value
  const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', timeout: 30_000 })
  const value = (r.stdout ?? '').trim()
  if (r.status !== 0 || !value) throw new Error(`gcloud token: ${(r.stderr ?? '').trim().slice(-200) || 'no output'}`)
  token = { value, at: Date.now() }
  return value
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message: string }
}

export const gemini = async (prompt: string, system: string, json = false): Promise<string> => {
  if (!PROJECT) throw new Error('set VERTEX_PROJECT (the GCP project with Vertex AI) in .env.local')
  const res = await fetch(
    `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 }, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  )
  const data = (await res.json()) as GeminiResponse
  if (data.error) throw new Error(`Gemini: ${data.error.message}`)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new Error(`Gemini: empty answer (${res.status})`)
  return text
}
