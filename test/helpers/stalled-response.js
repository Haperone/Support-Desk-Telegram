// Model fetch resolving at headers while its body remains blocked until abort.
export function stalledJsonResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
