/** 阅读面板只消费说明数据，节点选择与画布视口由页面管理。 */
import { useState, type Ref } from 'react'
import { ArrowDownRight, Code2, ListChecks, PanelRightClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ModuleDetail } from '../模块说明'
import { IconButton } from './图标按钮'
import { ImplementationBadge } from './实现标记'
import { viewNames, type ViewId } from '../视图'
import { FeatureList } from './能力明细'

const repository = 'https://github.com/Leslie622/Cogent/blob/main/'
const sourceGroups = ['实现', '模块与架构', '验收', '目标与计划'] as const

function sourceGroup(path: string): typeof sourceGroups[number] {
  if (path.startsWith('docs/计划/')) return '目标与计划'
  if (path.startsWith('tests/') || path.startsWith('docs/测试用例/')) return '验收'
  if (path.startsWith('docs/')) return '模块与架构'
  return '实现'
}

export function ModulePanel({ detail, headingRef, onClose, onNavigate }: { detail: ModuleDetail; headingRef: Ref<HTMLHeadingElement>; onClose: () => void; onNavigate: (id: ViewId) => void }) {
  const Icon = detail.icon
  const [section, setSection] = useState('responsibilities')
  return <aside className="module-panel select-text" aria-label="架构说明">
    <header className="side-header">
      <div className="flex min-w-0 items-center gap-2"><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><h2 ref={headingRef} tabIndex={-1} className="text-sm font-medium">{detail.name}</h2></div>
      <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}><PanelRightClose /></IconButton>
    </header>
    <div key={detail.name} className="module-panel-content" aria-live="polite">
      <div className="flex flex-col items-start gap-2">
        {detail.features !== undefined ? <FeatureList items={detail.features} /> : detail.showStatus !== false && <ImplementationBadge status={detail.status} />}
        <p className="text-xs text-muted-foreground">{detail.kind}</p>
      </div>
      <p className="mt-4 leading-relaxed">{detail.summary}</p>
      {detail.navigateTo !== undefined && <Button variant="outline" size="sm" className="mt-4" onClick={() => onNavigate(detail.navigateTo!)}><ArrowDownRight />展开{viewNames[detail.navigateTo]}{detail.navigateTo === 'ingress' || detail.navigateTo === 'execution' ? '链路' : ''}</Button>}
      <Tabs value={section} onValueChange={(value) => { if (typeof value === 'string') setSection(value) }} className="mt-6">
        <TabsList variant="line">
          <TabsTrigger value="responsibilities"><ListChecks />职责</TabsTrigger>
          <TabsTrigger value="sources"><Code2 />来源</TabsTrigger>
        </TabsList>
        <TabsContent value="responsibilities">
          <ol className="mt-4 space-y-4">
            {detail.responsibilities.map(item => <li key={item} className="leading-relaxed">{item}</li>)}
          </ol>
          <Separator className="my-6" />
          <h3 className="text-xs font-medium text-muted-foreground">技术边界</h3>
          <p className="mt-2 leading-relaxed text-muted-foreground">{detail.boundary}</p>
        </TabsContent>
        <TabsContent value="sources">
          <div className="mt-4 space-y-4">
            {sourceGroups.map(group => {
              const sources = detail.sources.filter(source => sourceGroup(source.path) === group)
              if (sources.length === 0) return null
              return <section key={group}>
                <h3 className="text-xs font-medium text-muted-foreground">{group}</h3>
                <ul className="mt-2 space-y-2">
                  {sources.map(source => <li key={source.path}>
                    <p className="text-xs text-muted-foreground">{source.symbol}</p>
                    <a href={repository + source.path.split('/').map(encodeURIComponent).join('/')} target="_blank" rel="noreferrer" className="block break-all underline underline-offset-2">
                      <code className="text-xs leading-relaxed">{source.path}</code>
                    </a>
                  </li>)}
                </ul>
              </section>
            })}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </aside>
}
