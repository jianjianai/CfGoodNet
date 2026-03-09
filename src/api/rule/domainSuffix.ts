// 匹配域名后缀，包含自身
export function DOMAINSuffixRulecreater(pattern: string): (urlString: string) => boolean {
  const normalized = pattern.trim().toLowerCase();
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    } catch {
      return false;
    }
  };
}
