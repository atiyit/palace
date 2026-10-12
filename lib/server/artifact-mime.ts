export function artifactMime(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return ({ md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', svg: 'image/svg+xml', js: 'text/javascript', css: 'text/css', xml: 'application/xml' } as Record<string, string>)[extension] || 'text/plain';
}
