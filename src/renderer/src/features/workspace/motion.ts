/** 工作区展开动画期间延后新预览器的首次重挂载，避免 Shiki/Shadow DOM 阻塞 200ms 过渡帧。 */
import { createContext } from 'react'

export const WorkspaceAnimatingContext = createContext(false)
