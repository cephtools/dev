// Small GitHub GraphQL client: retries transient failures, honours primary and
// secondary rate limits, and reports the remaining point budget to the caller.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RateLimitInfo {
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface GraphQLErrorItem {
  type?: string;
  message: string;
  path?: (string | number)[];
}

export interface GraphQLResult<T> {
  data: T;
  /** Non-fatal errors (e.g. NOT_FOUND for one aliased PR) returned alongside data. */
  errors: GraphQLErrorItem[];
}

export class GitHubError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** Thrown when continuing would require waiting longer than allowed for a rate limit to reset. */
export class RateLimitError extends GitHubError {
  resetAt: string | null;
  constructor(message: string, resetAt: string | null, status: number | null = null) {
    super(message, status);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/** Retries exhausted on 5xx / timeouts / network errors. Callers may retry with a smaller query. */
export class TransientError extends GitHubError {
  constructor(message: string, status: number | null = null) {
    super(message, status);
    this.name = 'TransientError';
  }
}

export interface ClientOptions {
  token: string;
  endpoint?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  maxRateLimitWaitMs?: number;
  baseBackoffMs?: number;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GitHubClient {
  private token: string;
  private endpoint: string;
  private fetchImpl: FetchLike;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  private maxRateLimitWaitMs: number;
  private baseBackoffMs: number;
  private log: (msg: string) => void;

  rateLimit: RateLimitInfo | null = null;
  totalCost = 0;
  requestCount = 0;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new GitHubError('A GitHub token is required (set GITHUB_TOKEN).');
    this.token = opts.token;
    this.endpoint = opts.endpoint ?? 'https://api.github.com/graphql';
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.maxRateLimitWaitMs = opts.maxRateLimitWaitMs ?? 120_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResult<T>> {
    let lastError: GitHubError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = this.baseBackoffMs * 2 ** (attempt - 1);
        this.log(`retry ${attempt}/${this.maxRetries} in ${backoff}ms after: ${lastError?.message}`);
        await this.sleep(backoff);
      }
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `bearer ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'ceph-pr-radar',
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        lastError = new TransientError(`network error: ${(err as Error).message}`);
        continue;
      }

      if (res.status === 401) throw new GitHubError('GitHub rejected the token (401 Unauthorized).', 401);

      if (res.status === 403 || res.status === 429) {
        const text = await res.text();
        const waitMs = rateLimitWaitMs(res, text);
        if (waitMs === null) throw new GitHubError(`GitHub returned ${res.status}: ${text.slice(0, 200)}`, res.status);
        if (waitMs > this.maxRateLimitWaitMs) {
          const resetAt = new Date(Date.now() + waitMs).toISOString();
          throw new RateLimitError(`rate limited for ${Math.round(waitMs / 1000)}s (limit ${this.maxRateLimitWaitMs / 1000}s)`, resetAt, res.status);
        }
        this.log(`rate limited (${res.status}); waiting ${Math.round(waitMs / 1000)}s`);
        await this.sleep(waitMs);
        attempt--; // waiting out a rate limit is not a failed attempt
        continue;
      }

      if (res.status >= 500) {
        lastError = new TransientError(`GitHub returned ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) {
        throw new GitHubError(`GitHub returned ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      }

      let body: { data?: T | null; errors?: GraphQLErrorItem[] };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        lastError = new TransientError('invalid JSON in GitHub response');
        continue;
      }
      const errors = body.errors ?? [];
      const data = body.data ?? null;
      this.recordRateLimit(data);

      const rateLimited = errors.find((e) => e.type === 'RATE_LIMITED');
      if (rateLimited) {
        const resetAt = this.rateLimit?.resetAt ?? null;
        const waitMs = resetAt ? Math.max(0, Date.parse(resetAt) - Date.now()) + 1000 : null;
        if (waitMs === null || waitMs > this.maxRateLimitWaitMs) {
          throw new RateLimitError(`GraphQL rate limit exhausted: ${rateLimited.message}`, resetAt);
        }
        await this.sleep(waitMs);
        attempt--;
        continue;
      }
      // GitHub reports query timeouts / resource limits as errors with null data.
      if (data === null) {
        const msg = errors.map((e) => e.message).join('; ') || 'empty response';
        if (/timeout|timed out|something went wrong|resource limits/i.test(msg)) {
          lastError = new TransientError(msg);
          continue;
        }
        throw new GitHubError(`GraphQL error: ${msg}`);
      }
      return { data, errors };
    }
    throw lastError ?? new TransientError('request failed');
  }

  private recordRateLimit(data: unknown): void {
    const rl = (data as { rateLimit?: RateLimitInfo } | null)?.rateLimit;
    if (rl && typeof rl.remaining === 'number') {
      this.rateLimit = rl;
      this.totalCost += rl.cost ?? 0;
    }
  }
}

/** Milliseconds to wait for a 403/429, or null if the response is not a rate limit. */
function rateLimitWaitMs(res: Response, text: string): number | null {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset) return Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
  if (/secondary rate limit|abuse detection|rate limit/i.test(text)) return 60_000;
  return null;
}
