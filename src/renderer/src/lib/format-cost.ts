/** 对话用量与压缩摘要共用的 USD 显示口径。 */
export function formatCost(usd: number, estimated?: boolean): string {
  // 小额只标下限，保留账单存在的提示。
  if (usd < 0.0001) return '<$0.0001'
  return `${estimated ? '≈' : ''}$${parseFloat(usd.toFixed(4))}`
}
