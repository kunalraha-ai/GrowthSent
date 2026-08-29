/**
 * Temporary deployment used only to apply the reviewed legacy Durable Object
 * deletion migration before the temporary Worker script itself is removed.
 * It has no Container binding and cannot access R2.
 */
export default {
  fetch(): Response {
    return new Response("retired", { status: 410 });
  },
};
