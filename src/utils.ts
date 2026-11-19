export function toArray<T>(value: unknown, key?: string): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && key && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, unknown>)[key] as T[];
  }
  return [];
}
