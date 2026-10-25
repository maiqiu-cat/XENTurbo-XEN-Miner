import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { createI18n } from '@/i18n'
import { ReadTimeoutError } from '@/core/readDeadline'
import { normalizeError } from '@/core/txManager'
import { RpcConfigurationError } from '@/core/rpc'
import { RpcRateLimitError, RpcReadInvalidatedError } from '@/core/rpcPolicy'

function translator() {
  const instance = createI18n({
    languages: () => ['zh-TW'],
    storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  instance.restore()
  return instance
}

describe('Traditional Chinese safety instructions', () => {
  it.each([
    [
      'Confirmation timed out. The transaction may still be pending. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.',
      '確認逾時。交易可能仍待確認。請勿重送。請檢查錢包 Activity 與區塊瀏覽器，再重新檢查待確認交易。'
    ],
    [
      'Recovery stopped during a storage change. The original backup is retained. Inspect again; do not clear site data or resend.',
      '儲存資料變更期間恢復已停止。原始備份已保留。請重新檢查；請勿清除網站資料或重送交易。'
    ],
    [
      'ids 1, 3 · re-mint 10d · Result partially verified (1/2 VMUs). Recheck before repeating this operation.',
      'ID 1, 3 · 重新鑄造 10 天 · 結果僅部分驗證（1/2 個 VMU）。請重新檢查後，才可重複此操作。'
    ],
    [
      'ids 1, 3 · Transaction confirmed; result verification incomplete. Recheck or inspect the explorer before repeating this operation.',
      'ID 1, 3 · 交易已確認，但結果尚未完整驗證。請重新檢查或查看區塊瀏覽器後，才可重複此操作。'
    ],
    [
      'The wallet confirms this nonce was consumed by another transaction. Check wallet Activity before preparing again.',
      '錢包確認此 nonce 已被另一筆交易使用。請先檢查錢包 Activity，再重新準備操作。'
    ]
  ])('keeps the full instruction and identifiers: %s', (source, expected) => {
    const i18n = translator()
    expect(i18n.message(source)).toBe(expected)
    i18n.setPreference('en')
    expect(i18n.message(source)).toBe(source)
  })

  it.each([
    [0, 1],
    [100, 1],
    [60_000, 60],
    [3_600_000, 60]
  ])('bounds the actual rate-limit error and translates its wait: %i ms', (delay, seconds) => {
    const error = new RpcRateLimitError(delay)
    const source = normalizeError(error)
    expect(source).toBe(
      `RPC endpoints are rate-limited. Retry in ${seconds}s. Your RPC list was preserved.`
    )
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
    const i18n = translator()
    expect(i18n.message(source)).toBe(
      `RPC 節點受到限流。請於 ${seconds} 秒後重試。RPC 清單已保留。`
    )
    i18n.setPreference('en')
    expect(i18n.message(source)).toBe(source)
  })

  it('translates an unknown rate-limit wait without guessing a duration or leaking the cause', () => {
    const error = new RpcRateLimitError(undefined, {
      cause: Object.assign(new Error('missing revert data'), {
        info: { error: { code: -32005, message: 'project ID request rate exceeded' } }
      })
    })
    const source = normalizeError(error)
    expect(source).toBe(
      'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
    )
    expect(error.retryAfterMs).toBeUndefined()
    const i18n = translator()
    expect(i18n.message(source)).toBe('RPC 節點受到限流。請稍候再重試。RPC 清單已保留。')
    i18n.setPreference('en')
    expect(i18n.message(source)).toBe(source)
    expect(source).not.toMatch(/missing revert data|CALL_EXCEPTION|32005|\d/)
  })

  it('explains an invalidated read without claiming a transaction was submitted', () => {
    const source = normalizeError(new RpcReadInvalidatedError())
    expect(source).toBe(
      'The RPC read was cancelled because its context changed. No transaction was submitted by this read. Start a new read with the current settings.'
    )
    const i18n = translator()
    expect(i18n.message(source)).toBe(
      'RPC 讀取因環境變更而取消。此次讀取未送出任何交易。請使用目前設定重新讀取。'
    )
    expect(source).not.toMatch(/do not resend/i)
    i18n.setPreference('en')
    expect(i18n.message(source)).toBe(source)
  })

  it.each([
    {
      shortMessage: 'server response 429 Too Many Requests',
      code: 'SERVER_ERROR',
      response: { statusCode: 429, headers: {} }
    },
    {
      shortMessage: 'missing revert data',
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32005, message: 'project ID request rate exceeded' } }
    },
    {
      message: '-32603 Internal JSON-RPC error',
      info: { error: { code: -32603, message: 'upstream rate limit reached' } }
    }
  ])('normalizes a preflight rate limit before SDK error wording: %j', (error) => {
    const before = structuredClone(error)
    const source = normalizeError(error)
    expect(source).toBe(
      'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
    )
    const i18n = translator()
    expect(i18n.message(source)).toBe('RPC 節點受到限流。請稍候再重試。RPC 清單已保留。')
    i18n.setPreference('en')
    expect(i18n.message(source)).toBe(source)
    expect(error).toEqual(before)
  })

  it('keeps a readable server delay in a preflight rate-limit message', () => {
    const source = normalizeError({
      shortMessage: 'server response 429 Too Many Requests',
      response: { statusCode: 429, headers: { 'retry-after': '2' } }
    })
    expect(source).toBe('RPC endpoints are rate-limited. Retry in 2s. Your RPC list was preserved.')
    expect(translator().message(source)).toBe('RPC 節點受到限流。請於 2 秒後重試。RPC 清單已保留。')
  })

  it.each([
    new Error('Failed to persist snapshot: QuotaExceededError: The quota has been exceeded.'),
    Object.assign(new Error('MetaMask - RPC Error: insufficient capacity for this request'), {
      code: -32603
    })
  ])('preserves non-transport quota or capacity diagnostics: %s', (error) => {
    const source = normalizeError(error)
    expect(source).toBe(error.message)
    expect(translator().message(source)).toBe(error.message)
    expect(source).not.toContain('RPC endpoints are rate-limited')
    expect(source).not.toContain('Your RPC list was preserved')
  })

  it.each([
    {
      shortMessage: 'missing revert data',
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32005, message: 'rate limit', data: '0x08c379a0' } }
    },
    {
      shortMessage: 'missing revert data',
      code: 'CALL_EXCEPTION',
      reason: 'rate limit in contract',
      info: { error: { code: -32005, message: 'rate limit' } }
    },
    {
      shortMessage: 'missing revert data',
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32602, message: 'invalid params: rate limit' } }
    },
    {
      shortMessage: 'missing revert data',
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32005, message: 'query returned more than 1000 results' } }
    }
  ])('does not replace a semantic or capacity failure with rate-limit advice: %j', (error) => {
    expect(normalizeError(error)).toBe(
      'Estimation reverted. Check VMU count/term limits and that you have enough balance for the service fee.'
    )
  })

  it('translates nested configuration reasons and bounded local timeout diagnostics', () => {
    const i18n = translator()
    expect(
      i18n.message(normalizeError(new RpcConfigurationError('eth', 'RPC endpoint must use HTTPS')))
    ).toBe(
      'Ethereum RPC 設定無效：RPC 節點必須使用 HTTPS。RPC 清單未被變更。請開啟 RPC 設定修正或重設為預設值。驗證成功前，鏈上讀取與交易將保持停用。'
    )
    expect(i18n.message(normalizeError(new ReadTimeoutError('RPC read', 12_000)))).toBe(
      '錢包或網路讀取逾時。RPC 讀取 超過 12000 毫秒時限。請檢查連線與錢包後，重新檢查交易記錄。請勿重送。'
    )
    expect(i18n.message('Preparation failed:  external diagnostic  ')).toBe(
      '準備失敗： external diagnostic  '
    )
    expect(
      i18n.message(
        'XENTurbo XEN Miner requires PC Google Chrome. You are currently using this browser.'
      )
    ).toContain('您目前使用的是 此瀏覽器。')
    expect(i18n.t('unknown application key' as never)).toBe('unknown application key')
  })

  it('flags untranslated application safety sentences in source, not arbitrary English diagnostics', () => {
    const root = resolve('src')
    const i18n = translator()
    const missing: string[] = []
    function visitDirectory(directory: string) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, item.name)
        if (item.isDirectory()) {
          if (!['i18n', 'abis'].includes(item.name)) visitDirectory(file)
          continue
        }
        if (!/\.(?:ts|vue)$/.test(file)) continue
        let source = readFileSync(file, 'utf8')
        if (file.endsWith('.vue')) {
          const { descriptor } = parse(source)
          source = [descriptor.script?.content, descriptor.scriptSetup?.content]
            .filter(Boolean)
            .join('\n')
        }
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
        function visit(node: ts.Node) {
          let text: string | undefined
          if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
          if (ts.isTemplateExpression(node))
            text =
              node.head.text + node.templateSpans.map((span) => `1${span.literal.text}`).join('')
          if (
            text &&
            /do not|never (?:discard|clear|resend)|before repeating|no transaction was submitted/i.test(
              text
            )
          ) {
            // Pending summaries append an instruction to a separately generated identity.
            let sentence = text.startsWith(' · ') ? `ids 1${text}` : text
            // These internal errors are normalized before any UI display. Test that route too.
            if (
              /^(?:LOCK_STORAGE_INVALID|PENDING_STORAGE_WRITE_FAILED|PENDING_STORAGE_READ_FAILED|WALLET_EVIDENCE_UNAVAILABLE):/.test(
                sentence
              )
            ) {
              sentence = normalizeError(new Error(sentence))
              expect(i18n.message(sentence)).toContain('請勿')
            }
            if (i18n.message(sentence) === sentence)
              missing.push(`${relative(root, file)}: ${text}`)
          }
          ts.forEachChild(node, visit)
        }
        visit(ast)
      }
    }
    visitDirectory(root)
    expect(missing).toEqual([])
  })
})
