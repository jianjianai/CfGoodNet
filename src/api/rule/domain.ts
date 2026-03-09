// 匹配完整域名
export function DOMAINRulecreater(pattern: string): (urlString: string) => boolean {
  const normalized = pattern.trim().toLowerCase();
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return hostname === normalized;
    } catch {
      return false;
    }
  };
}
