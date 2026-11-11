// Scriptable ACP v1 agent for adapter tests. Newline-delimited JSON-RPC over
// stdin/stdout. Environment switches keep each test small:
//
//   FAKE_AGY_ECHO=1          echo the prompt text in agent_message_chunk
//   FAKE_AGY_NO_TEXT=1       end_turn with no content updates
//   FAKE_AGY_PERMISSION=1    request permission before answering
//   FAKE_AGY_PROMPT_ERROR=1  return a JSON-RPC error for session/prompt
//   FAKE_AGY_AUTH_ERROR=1    return an auth-shaped error for session/new
//   FAKE_AGY_COUNT_FILE      write {newCount,promptCount,lastPrompt,lastNew}
//   FAKE_AGY_SLOW_MS         delay the prompt response
//   FAKE_AGY_CANCEL=1        answer a cancelled prompt with stopReason cancelled
//   FAKE_AGY_NO_USAGE=1      omit usage from the prompt response
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

let nextId = 10_000
let sessionId = 'sess_fake'
let model = 'gemini-4-argon'
let thought = 'medium'
let mode = 'default'
let newCount = 0
let promptCount = 0
let lastPrompt = ''
let lastNew = null
let pendingPromptId = null
let pendingPermissionId = null

const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
}

const configOptions = () => [
    {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
        options: [
            { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
            { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
            { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
            { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
            { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        ],
    },
    {
        id: 'thought_level',
        name: 'Thinking Level',
        category: 'thought_level',
        type: 'select',
        currentValue: thought,
        options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
        ],
    },
    {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: mode,
        options: [
            { value: 'default', name: 'Default' },
            { value: 'accept-edits', name: 'Accept edits' },
            { value: 'auto', name: 'Auto' },
            { value: 'plan', name: 'Plan' },
        ],
    },
]

const countFile = process.env.FAKE_AGY_COUNT_FILE
function record() {
    if (!countFile) return
    writeFileSync(
        countFile,
        `${JSON.stringify({ newCount, promptCount, lastPrompt, lastNew, sessionId, model, thought, mode })}\n`,
    )
}

function answer(text) {
    const response = {
        stopReason: 'end_turn',
        ...(process.env.FAKE_AGY_NO_USAGE === '1'
            ? {}
            : {
                  usage: {
                      totalTokens: 42,
                      inputTokens: 30,
                      outputTokens: 12,
                      thoughtTokens: 4,
                      cachedReadTokens: 3,
                      cachedWriteTokens: 0,
                  },
              }),
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'Thinking.' } } } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text } } } })
    send({ jsonrpc: '2.0', id: pendingPromptId, result: response })
    pendingPromptId = null
}

function startPrompt(id, params) {
    const prompt = Array.isArray(params?.prompt) ? params.prompt : []
    lastPrompt = prompt.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    promptCount += 1
    record()
    pendingPromptId = id

    if (process.env.FAKE_AGY_PROMPT_ERROR === '1') {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'provider exploded' } })
        pendingPromptId = null
        return
    }
    if (process.env.FAKE_AGY_PERMISSION === '1') {
        pendingPermissionId = ++nextId
        send({
            jsonrpc: '2.0',
            id: pendingPermissionId,
            method: 'session/request_permission',
            params: {
                sessionId,
                toolCall: { toolCallId: 'tc_1', title: 'Write a file', kind: 'edit', rawInput: { path: '/tmp/x' } },
                options: [
                    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ],
            },
        })
        return
    }
    const delay = Number(process.env.FAKE_AGY_SLOW_MS ?? 0)
    setTimeout(() => {
        if (pendingPromptId !== id) return
        if (process.env.FAKE_AGY_NO_TEXT === '1') {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
            pendingPromptId = null
            return
        }
        answer(process.env.FAKE_AGY_ECHO === '1' ? lastPrompt : 'PONG')
    }, Number.isFinite(delay) ? delay : 0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
        message = JSON.parse(text)
    } catch {
        return
    }

    if (message.method === undefined && pendingPermissionId !== null && message.id === pendingPermissionId) {
        pendingPermissionId = null
        const outcome = message.result?.outcome?.outcome === 'selected' ? message.result.outcome.optionId : 'cancelled'
        const delay = Number(process.env.FAKE_AGY_SLOW_MS ?? 0)
        setTimeout(() => {
            if (pendingPromptId !== null) answer(`PERMISSION ${outcome}`)
        }, Number.isFinite(delay) ? delay : 0)
        return
    }

    if (message.method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
                agentInfo: { name: 'Fake Antigravity', version: '0.0.0' },
                authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
            },
        })
        return
    }

    if (message.method === 'session/new') {
        newCount += 1
        lastNew = message.params
        record()
        if (process.env.FAKE_AGY_AUTH_ERROR === '1') {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Not logged in. Run agy to authenticate.' } })
            return
        }
        send({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: configOptions(), modes: { currentModeId: mode, availableModes: [] } } })
        return
    }

    if (message.method === 'session/set_config_option') {
        const id = message.params?.configId
        const value = message.params?.value
        if (id === 'model') model = value
        else if (id === 'thought_level') thought = value
        else if (id === 'mode') mode = value
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions() } } })
        send({ jsonrpc: '2.0', id: message.id, result: { configOptions: configOptions() } })
        return
    }

    if (message.method === 'session/prompt') {
        startPrompt(message.id, message.params)
        return
    }

    if (message.method === 'session/cancel') {
        if (pendingPromptId !== null && process.env.FAKE_AGY_CANCEL === '1') {
            send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } })
            pendingPromptId = null
        }
        return
    }

    if (message.method === 'session/close') {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
        return
    }

    if (message.id !== null && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
    }
})

rl.on('close', () => process.exit(0))
