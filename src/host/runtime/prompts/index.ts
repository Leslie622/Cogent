/**
 * Cogent 提示词工程统一出口与三层治理清单（docs/计划/提示词工程实现.md）。
 *
 * 三层结构：
 * 1. 系统提示词（system.ts + sections.ts）：静态核心契约 + 工作区/AGENTS.md + 回合动态段；
 * 2. 工具提示词（tools.ts）：宿主 6 工具定义与简洁回执；
 * 3. 消息流注入（reminders.ts）：<system-reminder> 封装、嵌套标签转义与元数据块。
 */
export {
  AGENTS_MD_MAX_CHARS,
  buildCoreSystemPrompt,
  buildSystemPrompt,
  readGitBranch,
  WORKSPACE_INSTRUCTION_FILES
} from './system'

export {
  buildDynamicSections,
  DYNAMIC_SECTION_ORDER,
  outputsSectionText,
  permissionSectionText,
  planModeSectionText,
  renderPromptWithSections,
  type DynamicSectionsInput
} from './sections'

export {
  AUTO_CONTINUE_MESSAGE,
  AUTO_CONTINUE_PREFIX,
  escapeSystemReminderTags,
  formatAttachmentsBlock,
  formatDirectoryReferencesBlock,
  outputReminderText,
  SYSTEM_REMINDER_SOURCES,
  wrapSystemReminder,
  type SystemReminderSource
} from './reminders'

export {
  ASK_USER_DESCRIPTION,
  ENTER_PLAN_DESCRIPTION,
  formatReportOutputsReceipt,
  READ_ATTACHMENT_DESCRIPTION,
  REPORT_OUTPUTS_DESCRIPTION,
  SUBMIT_PLAN_DESCRIPTION,
  TODO_WRITE_DESCRIPTION
} from './tools'

/** 全项目提示词资产清单（用于可观测对照与架构保真校验）。 */
export const PROMPT_INVENTORY = {
  system: [
    'preamble',
    'cwd',
    'cogent_outputs',
    'cogent_session_assets',
    'skills',
    'cogent_permission',
    'cogent_plan_active',
    'cogent_plan',
    'cogent_todos'
  ],
  hostTools: ['report_outputs', 'read_attachment', 'todo_write', 'ask_user', 'enter_plan', 'submit_plan'],
  reminders: ['output_reminder', 'attachments_meta', 'directory_references', 'auto_continue'],
  auxiliary: ['session-title', 'compaction-summary-prefix', 'compaction-instructions', 'model-connectivity-probe']
} as const
