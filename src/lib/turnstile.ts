// The production widget does not list localhost, so `next dev` uses Cloudflare's
// published test keys: the widget always passes and siteverify accepts its token.
const SITE_KEY = '0x4AAAAAAC2QlDdiFqByHU1Z';
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function turnstileSiteKey(dev: boolean): string {
  return dev ? TEST_SITE_KEY : SITE_KEY;
}

/** The secret for siteverify: the test one only in development on a local host. */
export function turnstileSecret(configured: string | undefined, dev: boolean, hostname: string): string | undefined {
  return dev && LOCAL_HOSTS.has(hostname) ? TEST_SECRET : configured;
}
