// Provider-neutral value formatters for the status bar.

export function formatIdleDuration(lastUpdated: Date): string {
    const ms = Date.now() - lastUpdated.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'idle';
    if (min < 60) return `idle ${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (remMin === 0) return `idle ${hr}h`;
    return `idle ${hr}h${remMin}m`;
}

export function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return (tokens / 1000000).toFixed(1) + 'M';
    } else if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}
