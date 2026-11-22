/** 将终态消息里的正文按原字符展示，保留 Markdown 写法；完整 JSON 仍是对账依据。 */
import { useMemo } from 'react'
import type { InspectEntryDetail } from '@/env.d'
import { readAssistantText } from '@/lib/inspect-detail'
import { DetailBlock } from './DetailBlock'

export function AssistantResult({ block }: { block: InspectEntryDetail['blocks'][number] }) {
  const result = useMemo(() => readAssistantText(block.content), [block.content])
  return <>
    {result.error !== null && <p role="alert" className="py-2 text-warning">{result.error}</p>}
    {result.text !== '' && <DetailBlock block={{ name: '完整回复', format: 'text', content: result.text }} />}
    {result.thinking !== '' && <DetailBlock defaultOpen={false} block={{ name: '思考内容', format: 'text', content: result.thinking }} />}
    <DetailBlock block={block} defaultOpen={result.text === ''} />
  </>
}
