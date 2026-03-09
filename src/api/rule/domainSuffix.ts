// 匹配域名后缀，包含自身
export function DOMAINSuffixRulecreater(pattern: string|null): (urlString: string) => boolean {
  if (!pattern) {
    return () => false;
  }
  const normalized = pattern.trim().toLowerCase();
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return hostname === normalized || hostname.endsWith(normalized);
    } catch {
      return false;
    }
  };
}
