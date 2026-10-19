// Known host secrets must not hide in embedded binary media before events or persistence.
export function containsKnownSecret(value, secrets) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  if (!needles.length) return false;
  if (typeof value === 'string') {
    if (needles.some((s) => value.includes(s))) return true;
    const media = /^data:(?:audio|video|image)\/[^,]+,([\s\S]*)$/i.exec(value);
    if (!media) return false;
    const header = value.slice(0, value.indexOf(','));
    let bytes;
    try { bytes = /;base64$/i.test(header) ? Buffer.from(media[1], 'base64') : Buffer.from(decodeURIComponent(media[1])); } catch { return false; }
    return needles.some((s) => bytes.includes(Buffer.from(s)));
  }
  if (Array.isArray(value)) return value.some((child) => containsKnownSecret(child, needles));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => containsKnownSecret(key, needles) || containsKnownSecret(child, needles));
  return false;
}
