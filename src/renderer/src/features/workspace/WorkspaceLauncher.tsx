/** 新标签页只呈现工作区已接入的能力；条目复用 shadcn Item，操作沿用工作区 store。
 *  Item 根元素默认 flex-wrap：面板窄到放不下时“打开”会被挤到下一行、标题列被压成一个字宽
 *  （line-clamp 对 CJK 逐字换行无效）。此处关掉换行，标题/说明单行 truncate，动作区不收缩。 */
import { FolderOpen, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { useWorkspaceStore } from '@/stores/workspace'

export function WorkspaceLauncher() {
  const workspace = useWorkspaceStore.getState()

  return <div className="h-full overflow-y-auto" data-workspace-launcher>
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-base font-semibold">新标签页</h1>
      <ItemGroup aria-label="工作区功能">
        <Item role="listitem" size="xs" variant="plain" className="flex-nowrap px-0">
          <ItemMedia variant="tile"><FolderOpen /></ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full min-w-0 truncate">文件</ItemTitle>
            <ItemDescription className="truncate">从目录中选择一个文件</ItemDescription>
          </ItemContent>
          <ItemActions className="shrink-0">
            <Button variant="secondary" aria-label="打开文件导航" onClick={() => workspace.openFiles()}>打开</Button>
          </ItemActions>
        </Item>
        <Item role="listitem" size="xs" variant="plain" className="flex-nowrap px-0">
          <ItemMedia variant="tile"><Globe /></ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full min-w-0 truncate">浏览器</ItemTitle>
            <ItemDescription className="truncate">浏览网页和预览应用。</ItemDescription>
          </ItemContent>
          <ItemActions className="shrink-0">
            <Button variant="secondary" aria-label="打开内置浏览器" onClick={() => workspace.openBrowser()}>打开</Button>
          </ItemActions>
        </Item>
      </ItemGroup>
    </div>
  </div>
}
