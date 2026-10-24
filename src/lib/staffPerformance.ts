export interface AttributedServiceLine {
  lineId: string;
  attributedRevenue: number;
}

export function uniqueServiceLines<T extends AttributedServiceLine>(lines: T[]): T[] {
  const byLineId = new Map<string, T>();
  for (const line of lines) {
    const existing = byLineId.get(line.lineId);
    if (!existing || line.attributedRevenue > existing.attributedRevenue) byLineId.set(line.lineId, line);
  }
  return Array.from(byLineId.values());
}