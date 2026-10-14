// Small monochrome symbols matching the native writer controls.
const paths: Record<string, string> = {
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sidebar:
    '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="M9 3v18M5 7h1M5 11h1"/>',
  bookmark: '<path d="M7 3h10v18l-5-4-5 4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  moon: '<path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  gear: '<path d="m10 2 4 0 .6 3 2 .9 2.6-1.4 2 3.4-2 2.1.2 2.3 2.4 1.8-2 3.5-2.9-.8-1.9 1.2-.2 3h-4l-.6-3-2-.9-2.6 1.4-2-3.4 2-2.1-.2-2.3L1 8.9l2-3.5 2.9.8 1.9-1.2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minusZoom: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M6 10h8"/>',
  plusZoom:
    '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M6 10h8M10 6v8"/>',
  note: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  todo: '<path d="m3 5 1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2M10 5h11M10 12h11M10 19h11"/>',
};
export function icon(name: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.bookmark}</svg>`;
}
