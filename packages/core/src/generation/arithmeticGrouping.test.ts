import { describe, expect, it } from 'vitest';
import { arithmeticFindings } from './arithmeticCheck.js';
describe('grouped integers from the 30-page Balanced RSA example', () => {
 it('does not report correct grouped integers as products', () => {
  expect(arithmeticFindings(String.raw`\[128^2=16\,384.\] \[187\cdot70=13\,090.\]`)).toEqual([]);
 });
 it.each([
  String.raw`\[10^6=1\,000\,000.\]`,
  String.raw`\[16\,384=128^2.\]`,
  String.raw`\[187\cdot70=13\, 090.\]`,
  String.raw`\[(16)(384)=6144.\]`
 ])('preserves numeric meaning in %s', markdown => { expect(arithmeticFindings(markdown)).toEqual([]); });
 it('skips ambiguous non-grouped digit spacing', () => {
  expect(arithmeticFindings(String.raw`\[16\,38=1638.\]`)).toEqual([]);
 });
 it('still catches incorrect explicit products', () => {
  expect(arithmeticFindings(String.raw`\[16\cdot384=6145.\]`)).toHaveLength(1);
 });
 it('still reports an actually wrong grouped value', () => {
  expect(arithmeticFindings(String.raw`\[128^2=16\,385.\]`)).toEqual([expect.objectContaining({reason:expect.stringContaining('16385')})]);
 });
});
