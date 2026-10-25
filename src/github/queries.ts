// GraphQL documents. Every query selects rateLimit so the collector can track its budget.

export const LIST_OPEN_PRS = /* GraphQL */ `
query ListOpenPrs($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft createdAt updatedAt baseRefName
        additions deletions changedFiles
        author { login __typename }
        labels(first: 30) { nodes { name } }
      }
    }
  }
}`;

// Connection sizes: `last: 100` keeps the newest events, which is what recency scoring
// needs. Anything older is merged from the cache or recorded as truncated history.
export const PR_DETAIL_FRAGMENT = /* GraphQL */ `
fragment PrDetail on PullRequest {
  number title url isDraft createdAt updatedAt baseRefName body
  additions deletions changedFiles
  author { login __typename }
  labels(first: 30) { nodes { name } }
  comments(last: 100) {
    totalCount
    nodes { id createdAt body isMinimized author { login __typename } }
  }
  reviews(last: 100) {
    totalCount
    nodes { id state submittedAt body author { login __typename } comments { totalCount } }
  }
  commits(last: 100) {
    totalCount
    nodes { commit { oid committedDate } }
  }
  lastCommit: commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
  timelineItems(last: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes { ... on HeadRefForcePushedEvent { id createdAt actor { login __typename } } }
  }
  files(first: 100) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { path additions deletions }
  }
}`;

/** One request fetching several PRs through aliases (p<number>). */
export function prDetailBatchQuery(numbers: number[]): string {
  const fields = numbers
    .map((n) => {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid PR number ${n}`);
      return `    p${n}: pullRequest(number: ${n}) { ...PrDetail }`;
    })
    .join('\n');
  return `query PrDetails($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
${fields}
  }
}
${PR_DETAIL_FRAGMENT}`;
}

export const PR_FILES_PAGE = /* GraphQL */ `
query PrFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions }
      }
    }
  }
}`;
