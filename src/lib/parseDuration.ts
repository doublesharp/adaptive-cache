export const parseDuration = (duration: string | number): number => {
  if (typeof duration === 'number') return duration;
  if (typeof duration === 'string') {
    const parts = duration.split(' ');
    const val = parseInt(parts[0]);
    const unit = parts[1];
    if (!unit) return val;
    if (unit.startsWith('second')) return val;
    if (unit.startsWith('minute')) return val * 60;
    if (unit.startsWith('hour')) return val * 3600;
    if (unit.startsWith('day')) return val * 86400;
  }
  return 5;
};
