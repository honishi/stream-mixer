import { clamp, panPositions } from './settings.js';

// Work in normalized field coordinates so preferences scale with the spread.
// Minimize deviation from both the even layout and the user's preferences,
// while reserving 65% of the even spacing between neighboring streams.
export function preferredPanPositions(entries, spread) {
  if (!entries.length) return [];
  const width = panPositions(2, spread)[1];
  // An explicit edge request must also reach the edge for a single stream,
  // whose automatic center slot would otherwise pull it 20% inward.
  if (entries.length === 1 && Math.abs(entries[0].panPreference) === 1) {
    return [entries[0].panPreference * width];
  }
  const gap = entries.length > 1 ? 1.3 / (entries.length - 1) : 0;
  const upper = 1 - gap * (entries.length - 1);
  const blocks = [];
  entries.forEach((entry, index) => {
    const slot = entries.length > 1 ? -1 + 2 * index / (entries.length - 1) : 0;
    const hasPreference = Number.isFinite(entry.panPreference);
    const weight = hasPreference ? 5 : 1;
    const desired = hasPreference ? (slot + 4 * clamp(entry.panPreference, -1, 1)) / weight : slot;
    blocks.push({ start: index, end: index, weight, sum: (desired - index * gap) * weight });
    // Weighted isotonic regression after subtracting the minimum spacing.
    while (blocks.length > 1) {
      const right = blocks.at(-1);
      const left = blocks.at(-2);
      if (left.sum / left.weight <= right.sum / right.weight) break;
      blocks.pop();
      left.end = right.end;
      left.sum += right.sum;
      left.weight += right.weight;
    }
  });
  const positions = [];
  for (const block of blocks) {
    const base = clamp(block.sum / block.weight, -1, upper);
    for (let index = block.start; index <= block.end; index++) positions[index] = (base + index * gap) * width;
  }
  return positions;
}

export function withPanPreference(entries, id, requestedPan, spread) {
  if (!Number.isFinite(requestedPan)) throw new Error('Invalid pan position.');
  const selected = entries.find((entry) => entry.id === id);
  if (!selected) throw new Error('This tab has already been released.');
  const width = panPositions(2, spread)[1];
  if (!width) throw new Error('Increase stereo width before adjusting positions.');
  const pan = clamp(requestedPan, -width, width);
  const reordered = entries.filter((entry) => entry.id !== id);
  // Pick the nearest spatial slot, then solve the actual positions softly.
  // Dropping near an occupied edge moves its old occupant inward instead of
  // trapping the dragged stream behind that occupant's minimum spacing.
  const insertAt = Math.round((pan / width + 1) * 0.5 * (entries.length - 1));
  reordered.splice(insertAt, 0,
    { ...selected, panPreference: pan / width });
  return reordered;
}
