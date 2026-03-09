// 总是匹配的规则
export function MATCHRulecreater(_pattern: string): (urlString: string) => boolean {
  return () => true;
}
