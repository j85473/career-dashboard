/** Current and legacy public career pages share the same published tenant IDs. */
export const PAYCOR_HOSTS = ['recruitingbypaycor.com', 'newton.newtonsoftware.com'] as const;
const hexId = /^[a-f0-9]{32}$/i;
export function paycorIdentity(value: string): { clientId: string; jobId?: string; detail: boolean } | null {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
            || !(PAYCOR_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())
            || !/^\/career\/(?:CareerHome|JobIntroduction)\.action$/.test(url.pathname)) return null;
        const clients = url.searchParams.getAll('clientId'), jobs = url.searchParams.getAll('id');
        if (clients.length !== 1 || !hexId.test(clients[0]) || jobs.length > 1 || jobs.some(id => !hexId.test(id))) return null;
        const detail = url.pathname.endsWith('/JobIntroduction.action');
        if (detail && jobs.length !== 1) return null;
        return { clientId: clients[0].toLowerCase(), jobId: jobs[0]?.toLowerCase(), detail };
    } catch { return null; }
}
export function paycorBoardUrl(clientId: string): string {
    if (!hexId.test(clientId)) throw Error('Invalid Paycor tenant identity');
    return 'https://recruitingbypaycor.com/career/CareerHome.action?clientId=' + clientId.toLowerCase();
}
export function paycorPostingUrl(clientId: string, jobId: string): string {
    if (!hexId.test(jobId)) throw Error('Invalid Paycor posting identity');
    return paycorBoardUrl(clientId).replace('CareerHome.action', 'JobIntroduction.action') + '&id=' + jobId.toLowerCase() + '&lang=en';
}
/** A filtered or translated landing page cannot prove a complete English catalogue. */
export function paycorUnfilteredBoard(value: string, board: string): boolean {
    const identity = paycorIdentity(value);
    if (!identity || identity.detail || paycorBoardUrl(identity.clientId) !== board) return false;
    const url = new URL(value);
    return [...url.searchParams].every(([key, value]) => key === 'clientId'
        || key === 'lang' && value === 'en' && url.searchParams.getAll(key).length === 1);
}
