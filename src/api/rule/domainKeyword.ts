// 匹配域名中包含关键字
export function DOMAINKeywordRulecreater(pattern: string): (urlString: string) => boolean {
  const normalized = pattern.trim().toLowerCase();
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return hostname.includes(normalized);
    } catch {
      return false;
    }
  };
}
