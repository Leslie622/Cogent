/** 对话本体与工作区生命周期独立，工作区常驻于 AppShell。 */
import { HomeChat } from './HomeChat'
export function HomeMain() {
  return <div className="h-full min-w-0" data-home-split>
    <HomeChat />
  </div>
}
