import { z } from 'zod'

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_WS_URL: z.string(),
})

/**
 * Agent LLM settings. Every field is optional: with no key configured the agent
 * layer falls back to its built-in mock, so a fresh clone runs without an
 * account. These are server-only — the key must never reach the browser, which
 * is why none of them carry the NEXT_PUBLIC_ prefix.
 */
export const agentEnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com/beta'),
  // Strict tool schemas are a beta endpoint feature; turn this off to fall back
  // to plain tool calls, which are still validated application-side.
  DEEPSEEK_STRICT_TOOLS: z.coerce.boolean().default(true),
  AGENT_BRAIN: z.enum(['deepseek', 'mock']).default('mock'),
})

export const serverEnvSchema = baseEnvSchema.extend({
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('24h'),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_WS_URL: z.string(),
  NEXT_PUBLIC_DAPP_URL: z.string().url().optional(),
  // Optional: injected wallets work without it, WalletConnect does not.
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: z.string().optional(),
  // Optional: falls back to the public Arc endpoint.
  NEXT_PUBLIC_ARC_RPC_URL: z.string().url().optional(),
})

export type AgentEnv = z.infer<typeof agentEnvSchema>
export type BaseEnv = z.infer<typeof baseEnvSchema>
export type ServerEnv = z.infer<typeof serverEnvSchema>
export type ClientEnv = z.infer<typeof clientEnvSchema>
