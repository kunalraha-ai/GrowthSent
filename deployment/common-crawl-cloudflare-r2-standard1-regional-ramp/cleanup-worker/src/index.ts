/**
 * Temporary no-op deployment used only to apply the reviewed v2 Durable
 * Object deletion migration to a retired regional ramp Worker. It has no
 * Container, Durable Object, or R2 binding.
 */
export default {
  fetch(): Response {
    return new Response("retired", { status: 410 });
  },
};
