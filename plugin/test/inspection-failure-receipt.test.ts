import { describe, expect, it } from 'vitest';
import { INSPECTION_FAILURE_CODES, MAX_INSPECTION_FAILURE_REASON_CHARS, inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';

describe('bounded actionable failure receipts', () => {
  it('preserves every supported failure code, including geometry refusal, and the full reason', () => {
    const reason='Requested atoms for the complete scientific assembly. '+ 'component identity; '.repeat(50)
      + 'Retry the complete requested view on desktop, or explicitly choose a cheaper representation.';
    for(const code of INSPECTION_FAILURE_CODES) expect(inspectionFailureReceipt(Object.assign(Error(reason),{code})))
      .toEqual({failure:code,failureReason:reason});
  });
  it('preserves unknown/legacy errors as render_failed with a nonempty reason', () => {
    expect(inspectionFailureReceipt(Object.assign(Error('An actual draw failed.'),{code:'upstream_render_error'})))
      .toEqual({failure:'render_failed',failureReason:'An actual draw failed.'});
    expect(inspectionFailureReceipt(undefined)).toEqual({failure:'render_failed',failureReason:'The host did not complete the request.'});
  });
  it('passes the exact shared bound intact, including a final actionable alternative', () => {
    const end=' Keep the source; retry the complete view on desktop.';
    const reason='x'.repeat(MAX_INSPECTION_FAILURE_REASON_CHARS-end.length)+end;
    expect(inspectionFailureReceipt(Object.assign(Error(reason),{code:'representation_budget_exceeded'})))
      .toEqual({failure:'representation_budget_exceeded',failureReason:reason});
  });
  it('discloses oversized upstream diagnostics and keeps both the original cause and final remedy', () => {
    const reason='Cause: unsupported upstream rendering configuration. '+ 'detail '.repeat(2000)
      + ' Remedy: keep the scientific source and retry the full view on the desktop.';
    const result=inspectionFailureReceipt(Object.assign(Error(reason),{code:'representation_budget_exceeded'}));
    expect(result.failure).toBe('representation_budget_exceeded');
    expect(result.failureReason.length).toBeLessThanOrEqual(MAX_INSPECTION_FAILURE_REASON_CHARS);
    expect(result.failureReason).toContain(`Diagnostic shortened from ${reason.length} characters`);
    expect(result.failureReason).toMatch(/^Cause:/);
    expect(result.failureReason).toMatch(/retry the full view on the desktop\.$/);
  });
  it('does not split supplementary Unicode characters at an explicit shortening boundary', () => {
    const reason='😀'.repeat(10000)+'Keep the full scene.';
    const result=inspectionFailureReceipt(Error(reason));
    expect(result.failureReason.length).toBeLessThanOrEqual(MAX_INSPECTION_FAILURE_REASON_CHARS);
    expect(result.failureReason).not.toMatch(/\p{Surrogate}/u);
  });
});
