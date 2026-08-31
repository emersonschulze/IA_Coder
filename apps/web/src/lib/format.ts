export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(total / 3600), Math.floor((total / 60) % 60), total % 60];
  return parts.map((value) => String(value).padStart(2, '0')).join(':');
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function compactTokens(value: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

export function money(value: number): string {
  return `US$ ${value.toFixed(2).replace('.', ',')}`;
}

export function hhmmss(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour12: false });
}

export function initialsOf(name: string, given?: string): string {
  if (given) return given.slice(0, 2).toUpperCase();
  const clean = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function pct(value: number): number {
  return Math.max(0, Math.min(100, value));
}
