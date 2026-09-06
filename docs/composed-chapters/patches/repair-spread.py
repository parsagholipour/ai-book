"""repairArcPages: spread the residual over the largest chapters round-robin instead of piling it on one."""
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
p=root+'packages/core/src/generation/bookArc.ts'; s=open(p).read()
old='''  let residual = targetPages - repaired.reduce((total, value) => total + value, 0);
  let guard = 0;
  while (residual !== 0 && guard++ < 20 * count) {
    const order = repaired.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
    const target = order.find((entry) => (residual > 0 ? entry.value < ceiling : entry.value > floor));
    if (!target) return undefined;
    repaired[target.index] = repaired[target.index]! + (residual > 0 ? 1 : -1);
    residual += residual > 0 ? -1 : 1;
  }
  return repaired;'''
new='''  let residual = targetPages - repaired.reduce((total, value) => total + value, 0);
  let guard = 0;
  // One page per chapter per round, largest first, so a four-page residual
  // widens four chapters by one rather than one chapter by four.
  let touched = new Set<number>();
  while (residual !== 0 && guard++ < 20 * count) {
    const order = repaired.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
    const fits = (entry: { value: number; index: number }) => (residual > 0 ? entry.value < ceiling : entry.value > floor);
    let target = order.find((entry) => fits(entry) && !touched.has(entry.index));
    if (!target) {
      touched = new Set<number>();
      target = order.find(fits);
      if (!target) return undefined;
    }
    touched.add(target.index);
    repaired[target.index] = repaired[target.index]! + (residual > 0 ? 1 : -1);
    residual += residual > 0 ? -1 : 1;
  }
  return repaired;'''
if new not in s:
    assert old in s; s=s.replace(old,new,1); open(p,'w').write(s)
t=root+'packages/core/src/generation/bookArc.test.ts'; s=open(t).read()
old_t='''    expect(repairArcPages([10, 3, 3, 3], 24)).toEqual([12, 4, 4, 4]);'''
new_t='''    expect(repairArcPages([10, 3, 3, 3], 24)).toEqual([12, 4, 4, 4]);
    // A residual is spread one page per chapter, largest first, never piled on one.
    expect(repairArcPages([8, 10, 7, 8, 8, 8, 8, 8, 8, 7, 8, 8, 4, 8, 8], 120)).toEqual([9, 11, 7, 9, 9, 8, 8, 8, 8, 7, 8, 8, 4, 8, 8]);'''
if new_t not in s:
    assert old_t in s; s=s.replace(old_t,new_t,1); open(t,'w').write(s)
print('repair spread prepared')
