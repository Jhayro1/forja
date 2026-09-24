/** Normalized error categories from v2/07-proveedores-y-costos.md. */
export const ERROR_CATEGORIES = ['auth', 'quota', 'network', 'timeout', 'environment', 'schema', 'policy', 'quality', 'protocol', 'unknown'] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type NormalizedError = {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  /** Provider code as reported (already redacted), e.g. `credits_required`. */
  providerCode?: string;
  /** Known wait before retrying, when the provider says so. */
  retryAfterMs?: number;
};

/**
 * Only quality failures count toward the escalation ladder (rule R09):
 * interruptions, quota, budget and environment problems never escalate the model.
 */
export function countsAsQualityFailure(error: NormalizedError): boolean {
  return error.category === 'quality';
}
