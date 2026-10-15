/**
 * The models that read an instruction, in the order they are tried.
 *
 * Reading what a user typed is one short, structured call, which is what a
 * free-tier model does well. Gemini goes first when a key is present; DeepSeek
 * stays behind it, so a Gemini outage or an exhausted free quota changes which
 * model answers and nothing else.
 *
 * Gemini is reached through Google's OpenAI-compatible endpoint, which is why
 * the same request body works for both. The model name is configuration, not a
 * constant: Google renames and retires these, and a name that stops working
 * should be a one-variable change.
 */
export interface IntentModel {
  id: 'gemini' | 'deepseek'
  apiKey: string
  baseUrl: string
  model: string
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODEL = 'deepseek-flash'

export function intentModels(env: Record<string, string | undefined> = process.env): IntentModel[] {
  const models: IntentModel[] = []

  const gemini = env['GEMINI_API_KEY']
  if (gemini !== undefined && gemini !== '') {
    models.push({
      id: 'gemini',
      apiKey: gemini,
      baseUrl: env['GEMINI_BASE_URL'] ?? GEMINI_BASE_URL,
      model: env['GEMINI_INTENT_MODEL'] ?? GEMINI_DEFAULT_MODEL,
    })
  }

  const deepseek = env['DEEPSEEK_API_KEY']
  if (deepseek !== undefined && deepseek !== '') {
    models.push({
      id: 'deepseek',
      apiKey: deepseek,
      baseUrl: env['DEEPSEEK_BASE_URL'] ?? DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL,
    })
  }

  return models
}
