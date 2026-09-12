// GLM 官方开源分词器的最小计数实现（零依赖）。
//
// 依据 HuggingFace zai-org/GLM-5.3 / GLM-5.3-Flash 的 tokenizer.json（两模型
// 文件字节级相同，一份通用）：BPE 模型 + Split(Isolated) + ByteLevel 预处理，
// 且 model.ignore_merges = true（整词命中词表直接输出，不走合并）。
// 已与官方 tokenizers 库对 500 条真实思考文本对拍 0 差异；修改任何一行前请重跑对拍。
//
// 文件本体在 public/tokenizer/glm-tokenizer.json（20.2MB，SHA256
// 19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d），
// 由 db worker 懒加载，主线程不接触。

export const TOKENIZER_URL = '/tokenizer/glm-tokenizer.json'

/** GLM 系模型的 model_id 前缀（接口不报 reasoning_tokens，需要文本计数） */
export const GLM_MODEL_PREFIX = 'GLM'

/** 字符 → token 的估算除数：500 样本官方口径标定值（GLM-5.3-Flash 实测 3.40）。
 *  仅用于精确计数完成前的过渡展示。 */
export const ESTIMATE_CHARS_PER_TOKEN = 3.4

type TokenizerJson = {
  model: {
    vocab: Record<string, number>
    merges: (string[] | string)[]
  }
  added_tokens?: { content: string }[]
}

// GPT-2 标准字节映射：可见字节原样映射，不可见字节平移到 256+ 区段
const GPT2_BYTES_TO_UNICODE: Map<number, string> = (() => {
  const printable = new Set<number>()
  for (let b = 33; b <= 126; b++) printable.add(b)
  for (let b = 161; b <= 172; b++) printable.add(b)
  for (let b = 174; b <= 255; b++) printable.add(b)
  const out = new Map<number, string>()
  let n = 0
  for (let b = 0; b < 256; b++) {
    out.set(b, printable.has(b) ? String.fromCodePoint(b) : String.fromCodePoint(256 + n++))
  }
  return out
})()

const textEncoder = new TextEncoder()

export class GlmTokenCounter {
  private readonly vocab: Record<string, number>
  /** 相邻片段对的合并优先级：key = a + '\u0000' + b，value = 排名（越小越先合并） */
  private readonly ranks: Map<string, number>
  private readonly special: Set<string>
  /**
   * 预切分正则（对应 tokenizer.json 的 Split 步骤）。
   * 外层包一层捕获组，String.split 才能把命中的片段保留在结果里；
   * 原始 pattern 用了 JS 不支持的 (?i:...)，已手工等价改写。
   */
  private readonly splitRe = new RegExp(
    "((?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+)",
    'gu',
  )

  constructor(json: unknown) {
    const t = json as TokenizerJson
    this.vocab = t.model.vocab
    this.ranks = new Map()
    for (const m of t.model.merges) {
      const [a, b] = Array.isArray(m) ? m : m.split(' ')
      this.ranks.set(a + '\u0000' + b, this.ranks.size)
    }
    this.special = new Set((t.added_tokens ?? []).map((a) => a.content))
  }

  /** 返回文本的 token 数 */
  count(text: string): number {
    let total = 0
    // 特殊 token 按占位符切开（思考正文一般不含，稳妥起见）
    let rest = text
    for (const sp of this.special) {
      if (rest.includes(sp)) rest = rest.split(sp).join('\u0001')
    }
    const pieces = rest.split(this.splitRe)
    for (const piece of pieces) {
      if (!piece || piece === '\u0001') continue
      total += this.countPiece(piece)
    }
    return total
  }

  private countPiece(piece: string): number {
    // UTF-8 字节 → GPT-2 可打印字符空间
    const bytes = textEncoder.encode(piece)
    let word = ''
    for (const b of bytes) word += GPT2_BYTES_TO_UNICODE.get(b) ?? ''
    // ignore_merges: true —— 整词命中词表直接输出
    if (Object.hasOwn(this.vocab, word)) return 1
    // 逐级合并：每次找排名最小的相邻对，合并一对后重扫
    const parts = [...word]
    while (parts.length > 1) {
      let bestRank = Infinity
      let bestIdx = -1
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i]! + '\u0000' + parts[i + 1]!)
        if (r !== undefined && r < bestRank) {
          bestRank = r
          bestIdx = i
        }
      }
      if (bestIdx < 0) break
      parts.splice(bestIdx, 2, parts[bestIdx]! + parts[bestIdx + 1]!)
    }
    return parts.length
  }
}
