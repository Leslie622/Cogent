/**
 * Lexical 行内原子实体节点（技能 / 命令）及复用的实体芯片呈现件。
 * 输入区（ComposerLexicalEditor）与历史消息气泡（MessageRow）共用 EntityChip，视觉同源。
 */
import type { ReactElement } from 'react'
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import { IconDatabase, IconPlug, IconTerminal2, IconWand } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { composerEntityText, ENTITY_SENTINEL, type ComposerEntity } from './types'

export function EntityChip({
  kind,
  name,
  className
}: {
  kind: ComposerEntity['kind']
  name: string
  className?: string
}) {
  const isSkill = kind === 'skill'
  return (
    <span
      data-entity-chip={kind}
      data-entity-name={name}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline text-sm leading-snug font-medium select-none',
        isSkill
          ? 'bg-violet-500/12 text-violet-600 dark:bg-violet-400/16 dark:text-violet-300'
          : 'bg-primary/10 font-mono text-primary dark:bg-primary/18',
        className
      )}
    >
      {kind === 'mcp-resource' ? <IconDatabase className="size-3.5 shrink-0" /> : kind === 'mcp-prompt' ? <IconPlug className="size-3.5 shrink-0" /> : isSkill ? (
        <IconWand className="size-3.5 shrink-0 stroke-[2]" />
      ) : (
        <IconTerminal2 className="size-3.5 shrink-0 stroke-[2]" />
      )}
      <span>{isSkill ? name : kind === 'mcp-resource' ? `@${name}` : kind === 'mcp-prompt' ? `/mcp:${name}` : `/${name}`}</span>
    </span>
  )
}

export type SerializedComposerEntityNode = Spread<
  {
    entity: ComposerEntity
  },
  SerializedLexicalNode
>

export class ComposerEntityNode extends DecoratorNode<ReactElement> {
  __entity: ComposerEntity

  static getType(): string {
    return 'composer-entity'
  }

  static clone(node: ComposerEntityNode): ComposerEntityNode {
    return new ComposerEntityNode(node.__entity, node.__key)
  }

  static importJSON(serializedNode: SerializedComposerEntityNode): ComposerEntityNode {
    return $createComposerEntityNode(serializedNode.entity)
  }

  constructor(entity: ComposerEntity, key?: NodeKey) {
    super(key)
    this.__entity = entity
  }

  exportJSON(): SerializedComposerEntityNode {
    return {
      type: 'composer-entity',
      version: 1,
      entity: this.__entity
    }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'inline-block mx-0.5 align-baseline'
    span.setAttribute('data-lexical-entity', this.__entity.kind)
    span.setAttribute('data-lexical-entity-name', this.__entity.name)
    return span
  }

  updateDOM(): false {
    return false
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span')
    span.textContent = composerEntityText(this.__entity)
    return { element: span }
  }

  isInline(): true {
    return true
  }

  isIsolated(): true {
    return true
  }

  isKeyboardSelectable(): true {
    return true
  }

  getTextContent(): string {
    return ENTITY_SENTINEL
  }

  getEntity(): ComposerEntity {
    return this.__entity
  }

  decorate(): ReactElement {
    const entity = this.__entity
    return <EntityChip kind={entity.kind} name={entity.kind === 'mcp-resource' || entity.kind === 'mcp-prompt' ? `${entity.server}:${entity.name}` : entity.name} />
  }
}

export function $createComposerEntityNode(entity: ComposerEntity): ComposerEntityNode {
  return $applyNodeReplacement(new ComposerEntityNode(entity))
}

export function $isComposerEntityNode(node: LexicalNode | null | undefined): node is ComposerEntityNode {
  return node instanceof ComposerEntityNode
}
