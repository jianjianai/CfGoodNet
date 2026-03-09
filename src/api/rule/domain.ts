// 匹配完整域名
export function DOMAINRulecreater(pattern: string | null): (urlString: string) => boolean {
    if (!pattern) {
        return () => false;
    }
    const normalized = pattern.trim().toLowerCase() ?? "";
    return (urlString: string) => {
        try {
            const hostname = new URL(urlString).hostname.toLowerCase();
            return hostname === normalized;
        } catch {
            return false;
        }
    };
}
