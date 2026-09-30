import { describe, it, expect } from 'vitest';
import { compareActivity, type ActivityItem } from '../src/presales/inquiry-activity.service';

const item = (id: string, ms: number): ActivityItem => ({ id, type: 'follow_up', occurredAt: new Date(ms), actor: null, details: {} });

describe('compareActivity', () => {
  it('newest first', () => {
    expect([item('a:1', 1), item('a:2', 3), item('a:3', 2)].sort(compareActivity).map((i) => i.id)).toEqual(['a:2', 'a:3', 'a:1']);
  });
  it('events at the same instant from different sources order the same whatever order the sources arrive in', () => {
    const a = [item('assignment:1', 5), item('stage_change:1', 5), item('follow_up:1', 5)];
    const expected = ['stage_change:1', 'follow_up:1', 'assignment:1'];
    expect([...a].sort(compareActivity).map((i) => i.id)).toEqual(expected);
    expect([...a].reverse().sort(compareActivity).map((i) => i.id)).toEqual(expected);
    expect([a[1], a[2], a[0]].sort(compareActivity).map((i) => i.id)).toEqual(expected);
  });
});
