// 总是匹配的规则
export function MATCHRulecreater(_pattern: string|null): (urlString: string) => boolean {
  return () => true;
}
