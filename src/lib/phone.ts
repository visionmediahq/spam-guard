/** A tel: link for a phone number as displayed ("063-12 34 56" → "tel:063123456"), unless one is given. */
export function telHref(phone: string, phoneHref?: string): string {
  return phoneHref ?? `tel:${phone.replace(/[^\d+]/g, '')}`
}
