/** 阅读面板只消费说明数据，节点选择与画布视口由页面管理。 */
import { ArrowDownRight, Code2, ListChecks, PanelRightClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ModuleDetail } from '../模块说明'
import { IconButton } from './图标按钮'
import { ImplementationBadge } from './实现标记'
import { viewNames, type ViewId } from '../视图'
import { FeatureList } from './能力明细'

export function ModulePanel({ detail, onClose, onNavigate }: { detail: ModuleDetail; onClose: () => void; onNavigate: (id: ViewId) => void }) {
  const Icon = detail.icon
  return <aside className="module-panel select-text" aria-label="架构说明">
    <header className="side-header">
      <div className="flex min-w-0 items-center gap-2"><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><h2 className="text-sm font-medium">{detail.name}</h2></div>
      <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}><PanelRightClose /></IconButton>
    </header>
    <div key={detail.name} className="module-panel-content" aria-live="polite">
      <div className="flex flex-col items-start gap-2">
        {detail.features !== undefined ? <FeatureList items={detail.features} /> : detail.showStatus !== false && <ImplementationBadge status={detail.status} />}
        <p className="text-xs text-muted-foreground">{detail.kind}</p>
      </div>
      <p className="mt-4 leading-relaxed">{detail.summary}</p>
      {detail.navigateTo !== undefined && <Button variant="outline" size="sm" className="mt-4" onClick={() => onNavigate(detail.navigateTo!)}><ArrowDownRight />展开{viewNames[detail.navigateTo]}{detail.navigateTo === 'ingress' || detail.navigateTo === 'execution' ? '链路' : ''}</Button>}
      <Tabs defaultValue="responsibilities" className="mt-6">
        <TabsList variant="line">
          <TabsTrigger value="responsibilities"><ListChecks />职责</TabsTrigger>
          <TabsTrigger value="sources"><Code2 />源码</TabsTrigger>
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
          <ul className="mt-4 space-y-4">
            {detail.sources.map(source => <li key={source.path}>
              <p className="text-xs text-muted-foreground">{source.symbol}</p>
              <code className="mt-2 block break-all text-xs leading-relaxed">{source.path}</code>
            </li>)}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  </aside>
}
