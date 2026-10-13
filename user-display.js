const placeholder = /^[-–—]+$/u;

export function customerName(person, fallback = person?.user_id ?? person?.id ?? '') {
  const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const name = [person?.first_name, person?.last_name].map(clean)
    .filter(part => part && !placeholder.test(part)).join(' ');
  const username = clean(person?.username).replace(/^@/, '');
  return name || (username ? `@${username}` : String(fallback));
}
